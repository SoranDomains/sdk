/**
 * Soran hint server — Cloudflare Worker edition. ZERO dependencies.
 *
 * Same job as the Node example (`../hint-server`): serve the discovery
 * endpoints @sorandomains/lookup uses as its `hintUrl`, for ONE namespace,
 * fed from your Registrar's chain events. Adapted to the Workers platform:
 *
 *   - the poll loop becomes a CRON TRIGGER (see wrangler.toml) — this is why
 *     it must be a Worker, not Pages: Pages Functions have no cron, so the
 *     index would never update;
 *   - the JSON state file becomes a KV value (binding: HINT_KV, key "state");
 *   - @stellar/stellar-sdk is DROPPED entirely: Soroban RPC's
 *     `xdrFormat: "json"` returns events as plain JSON ({"symbol":"issued"},
 *     hex bytes, "G…" addresses), so no XDR decoding is needed. The one thing
 *     that required the SDK — discovering the Registrar from the Registry —
 *     becomes the required var SORAN_REGISTRAR_ID (read it once with
 *     `owner.registrarOf(ns)`, or from your console's namespace page).
 *
 * TRUST MODEL (same as always): hints are discovery, not truth — the SDK
 * verifies every candidate on chain, so this Worker can be stale or wrong
 * without safety consequences. No auth, no database, no uptime duty.
 *
 * PLATFORM DISCIPLINE (the part an audit cares about):
 *   - CORS is open (`*`): the SDK's primary consumers are browser wallets,
 *     and the platform API serves the same endpoints with open CORS — it is
 *     part of the de-facto hint contract.
 *   - KV writes happen ONLY when state actually changed: an idle namespace
 *     writes ~0/day, keeping copy-deployers inside KV's free-tier write
 *     quota even at a 1-minute cron.
 *   - Public reads are edge-cached (30s, `caches.default`) and the routes
 *     that need no state answer before any KV read — a request flood is
 *     served from cache instead of billing KV reads and CPU per hit.
 *   - The RPC is operator-configured but still treated as untrusted input:
 *     every field taken from it is type-checked and length-clamped, and the
 *     total name count is capped, so a hostile RPC can at worst stall THIS
 *     index — never harm consumers (the SDK re-verifies) and never grow the
 *     KV value without bound.
 *   - A cursor that falls out of the RPC's retention window self-heals: the
 *     poller re-anchors at the current ledger, counts the gap in `gaps`
 *     (visible on /healthz), and keeps going — reseed if the gap matters.
 *
 * Vars (wrangler.toml): SORAN_NAMESPACE, SORAN_REGISTRAR_ID (both required),
 * SORAN_RPC_URL (default: testnet public RPC), SORAN_START_LEDGER (optional
 * backfill start — must be within your RPC's event retention).
 * Binding: HINT_KV (KV namespace).
 *
 * Seeding names older than the RPC event-retention window: put a JSON array
 * under KV key "seed" — [{ "name": "alice.acme", "holder": "G…" }, …]. The
 * seed is re-merged on EVERY cron run (chain events always win; a seed entry
 * only fills names the chain hasn't spoken about), so seeding works whenever
 * you add it — before or after deploy.
 */

const LABEL_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
// Hint-grade address check (length + alphabet). Full strkey checksum
// validation is deliberately omitted: the SDK re-verifies on chain, so a
// mistyped seed entry costs a wasted probe, never a wrong answer.
const ADDR_RE = /^[GC][A-Z2-7]{55}$/;
const MAX_EVENTS_PER_NAME = 100;
const MAX_NAMES_PER_HOLDER = 100;
const MAX_PAGES_PER_RUN = 5; // stay well under the per-invocation subrequest cap
// Hard bound on index size: KV values cap at 25 MiB and every request parses
// the whole state, so refuse growth past this rather than wedging silently.
// 50k quiet names ≈ a few MiB; /healthz reports `full: true` when hit.
const MAX_NAMES = 50_000;
const CACHE_TTL_SECS = 30;

const HOLDER_EVENTS = { issued: "issued", reclaimed: "reclaimed", transfer: "transferred" };

function hexToUtf8(hex) {
  if (typeof hex !== "string" || hex.length % 2 !== 0 || /[^0-9a-fA-F]/.test(hex)) return null;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return new TextDecoder().decode(bytes);
}

function json(body, status = 200, cacheable = false) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      // Browser wallets are the primary consumers — CORS is part of the hint
      // contract (simple GETs only, so no preflight handling is needed).
      "access-control-allow-origin": "*",
      "x-content-type-options": "nosniff",
      ...(cacheable ? { "cache-control": `public, max-age=${CACHE_TTL_SECS}` } : {}),
    },
  });
}

async function rpcCall(url, method, params) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`${method}: HTTP ${res.status}`);
  const body = await res.json();
  if (body.error) throw new Error(`${method}: ${body.error.message ?? "rpc error"}`);
  return body.result;
}

const EMPTY_STATE = {
  cursor: null,
  anchorLedger: 0,
  lastLedger: 0,
  gaps: 0,
  lastError: null,
  lastWriteAt: "",
  holders: {},
  log: {},
};

async function loadStateRaw(env) {
  const raw = await env.HINT_KV.get("state");
  if (!raw) return { state: { ...EMPTY_STATE }, raw: "" };
  try {
    return { state: { ...EMPTY_STATE, ...JSON.parse(raw) }, raw };
  } catch {
    return { state: { ...EMPTY_STATE }, raw: "" };
  }
}

function applyEvent(state, namespace, kind, valueJson, ledger, txHash, at) {
  const action = HOLDER_EVENTS[kind];
  const vec = valueJson?.vec;
  if (!action || !Array.isArray(vec) || vec.length < 2) return;
  const label = hexToUtf8(vec[0]?.bytes);
  const holder = vec[1]?.address;
  if (!label || !LABEL_RE.test(label) || label.length > 63) return;
  if (typeof holder !== "string" || !ADDR_RE.test(holder)) return;
  // RPC fields are untrusted input: clamp before they touch persisted state.
  if (!Number.isSafeInteger(ledger) || ledger < 0) return;
  const hash = String(txHash ?? "").slice(0, 64);
  const when = String(at ?? "").slice(0, 40);
  const name = `${label}.${namespace}`;
  if (!(name in state.holders) && Object.keys(state.holders).length >= MAX_NAMES) return;
  state.holders[name] = holder;
  const log = (state.log[name] ??= []);
  // Idempotent under cron overlap / cursor replay: the same chain event must
  // not append twice, and replays must not disorder history.
  if (log.some((e) => e.txHash === hash && e.action === action && e.ledger === ledger)) return;
  log.push({ action, ledger, txHash: hash, at: when });
  log.sort((a, b) => a.ledger - b.ledger);
  if (log.length > MAX_EVENTS_PER_NAME) log.splice(0, log.length - MAX_EVENTS_PER_NAME);
}

async function poll(env) {
  const namespace = (env.SORAN_NAMESPACE ?? "").toLowerCase();
  const registrarId = env.SORAN_REGISTRAR_ID ?? "";
  if (!LABEL_RE.test(namespace) || !/^C[A-Z2-7]{55}$/.test(registrarId)) {
    throw new Error("configure SORAN_NAMESPACE and SORAN_REGISTRAR_ID (wrangler.toml [vars])");
  }
  const rpcUrl = env.SORAN_RPC_URL ?? "https://soroban-testnet.stellar.org";
  const { state, raw } = await loadStateRaw(env);
  state.lastError = null;

  // Merge the seed on EVERY run (idempotent; chain events always win). One
  // extra KV read per cron — well inside the free read quota.
  try {
    const seed = JSON.parse((await env.HINT_KV.get("seed")) ?? "[]");
    for (const row of Array.isArray(seed) ? seed : []) {
      const name = String(row?.name ?? "").toLowerCase();
      const holder = String(row?.holder ?? "");
      if (!name.endsWith(`.${namespace}`) || !ADDR_RE.test(holder)) continue;
      if (!(name in state.holders) && Object.keys(state.holders).length < MAX_NAMES) {
        state.holders[name] = holder;
      }
    }
  } catch {
    /* malformed seed — ignore; chain events remain authoritative */
  }

  const filters = [{ type: "contract", contractIds: [registrarId] }];
  try {
    for (let page = 0; page < MAX_PAGES_PER_RUN; page++) {
      let params;
      if (state.cursor) {
        params = { filters, pagination: { cursor: state.cursor, limit: 100 }, xdrFormat: "json" };
      } else {
        // A stable anchor: without it, an empty namespace would re-anchor at
        // the CURRENT ledger on every run and skip everything in between.
        if (!state.anchorLedger) {
          state.anchorLedger =
            Number(env.SORAN_START_LEDGER ?? 0) > 0
              ? Number(env.SORAN_START_LEDGER)
              : (await rpcCall(rpcUrl, "getLatestLedger", {})).sequence;
        }
        params = {
          startLedger: state.anchorLedger,
          filters,
          pagination: { limit: 100 },
          xdrFormat: "json",
        };
      }
      const result = await rpcCall(rpcUrl, "getEvents", params);
      for (const ev of result.events ?? []) {
        const kind = ev.topicJson?.[0]?.symbol;
        applyEvent(state, namespace, kind, ev.valueJson, ev.ledger, ev.txHash, ev.ledgerClosedAt);
        if (Number.isSafeInteger(ev.ledger) && ev.ledger > state.lastLedger) {
          state.lastLedger = ev.ledger;
        }
      }
      // The cursor is untrusted RPC output too — accept only a sane string.
      if (typeof result.cursor === "string" && result.cursor.length > 0 && result.cursor.length <= 128) {
        state.cursor = result.cursor;
      }
      if (!result.events || result.events.length < 100) break;
    }
  } catch (e) {
    // SELF-HEAL: a cursor/anchor that fell out of the RPC's event-retention
    // window would otherwise fail every future run. Re-anchor at the current
    // ledger, count the gap (visible on /healthz), and let the next run
    // continue. Events inside the gap are missed — reseed if that matters.
    if (state.cursor || state.anchorLedger) {
      state.cursor = null;
      state.anchorLedger = 0;
      state.gaps = (state.gaps ?? 0) + 1;
      state.lastError = `poll failed (${String(e?.message ?? e).slice(0, 160)}) — re-anchored; events in the gap are missed`;
    } else {
      state.lastError = String(e?.message ?? e).slice(0, 200);
    }
  }

  // Write discipline (KV free tier allows 1,000 writes/day; a naive put per
  // 1-minute cron is 1,440): material changes (events, seeds, errors, anchor)
  // write immediately; the RPC cursor advances on EVERY poll even with zero
  // events, so cursor-only drift is persisted at most hourly — an unpersisted
  // cursor merely means the next poll re-reads an empty span. Idle namespace:
  // ~24 writes/day.
  const strip = (o) => JSON.stringify({ ...o, cursor: undefined, lastWriteAt: undefined });
  const material = strip(state) !== (raw ? strip(JSON.parse(raw)) : "");
  const cursorDrift = raw ? state.cursor !== JSON.parse(raw).cursor : state.cursor !== null;
  const lastWriteMs = Date.parse(state.lastWriteAt || 0) || 0;
  if (material || (cursorDrift && Date.now() - lastWriteMs > 3_600_000)) {
    state.lastWriteAt = new Date().toISOString();
    await env.HINT_KV.put("state", JSON.stringify(state));
  }
  if (state.lastError) throw new Error(state.lastError);
  return state;
}

export default {
  /** Cron Trigger: index new chain events into KV. */
  async scheduled(_event, env, ctx) {
    // Surface failures in `wrangler tail` / observability — an unhandled
    // rejection inside waitUntil is reported as an opaque internal error.
    ctx.waitUntil(
      poll(env).catch((e) => console.error(`poll failed (next cron retries): ${e?.message ?? e}`)),
    );
  },

  /** HTTP: serve the hint contract from the KV index, edge-cached. */
  async fetch(request, env, ctx) {
    const namespace = (env.SORAN_NAMESPACE ?? "").toLowerCase();
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);

    // Routes that need no state answer before any KV read.
    if (url.pathname === "/v1/showcase") return json({ namespaces: [namespace] }, 200, true);
    const isByHolder =
      parts.length === 4 && parts[0] === "v1" && parts[1] === "names" && parts[2] === "by-holder";
    const isReverse = parts.length === 3 && parts[0] === "v1" && parts[1] === "reverse";
    const isHistory =
      parts.length === 5 && parts[0] === "v1" && parts[1] === "names" && parts[4] === "history";
    const isHealth = url.pathname === "/healthz";
    if (!isByHolder && !isReverse && !isHistory && !isHealth) {
      return json({ error: "not_found" }, 404);
    }
    // Validate inputs before spending a KV read; never echo unvalidated text.
    if ((isByHolder && !ADDR_RE.test(parts[3])) || (isReverse && !ADDR_RE.test(parts[2]))) {
      return json({ error: "bad_address" }, 400);
    }
    if (isHistory && (!LABEL_RE.test(parts[2]) || !LABEL_RE.test(parts[3].toLowerCase()))) {
      return json({ error: "bad_name" }, 400);
    }

    // Edge cache: public, identical for all clients, refreshed by cron at
    // most once a minute — a request flood hits the cache, not KV/CPU.
    const cache = caches.default;
    if (request.method === "GET" && !isHealth) {
      const hit = await cache.match(request);
      if (hit) return hit;
    }

    const { state } = await loadStateRaw(env);
    let res;
    if (isHealth) {
      return json({
        ok: state.lastError === null,
        namespace,
        names: Object.keys(state.holders).length,
        full: Object.keys(state.holders).length >= MAX_NAMES,
        lastLedger: state.lastLedger,
        lastWriteAt: state.lastWriteAt || null,
        gaps: state.gaps ?? 0,
        lastError: state.lastError,
      });
    } else if (isByHolder) {
      const addr = parts[3];
      const all = Object.entries(state.holders)
        .filter(([, h]) => h === addr)
        .map(([name]) => ({ name, namespace, holder: addr }));
      res = json(
        {
          holder: addr,
          names: all.slice(0, MAX_NAMES_PER_HOLDER),
          truncated: all.length > MAX_NAMES_PER_HOLDER,
        },
        200,
        true,
      );
    } else if (isReverse) {
      const found = Object.entries(state.holders).find(([, h]) => h === parts[2]);
      res = found ? json({ name: found[0] }, 200, true) : json({ error: "no_name" }, 404, true);
    } else {
      const name = `${parts[3]}.${parts[2]}`.toLowerCase();
      const events = state.log[name];
      if (!events && !(name in state.holders)) {
        res = json({ error: "name_not_found", name }, 404, true);
      } else {
        const first = events?.find((e) => e.action === "issued");
        res = json(
          {
            name,
            // Only what THIS worker has witnessed — seeded/pre-retention
            // names have no issuance event here; the platform indexer is
            // fuller.
            issuedAt: first?.at ?? "",
            issuedLedger: first?.ledger ?? 0,
            events: [...(events ?? [])].reverse(),
          },
          200,
          true,
        );
      }
    }
    if (request.method === "GET") ctx.waitUntil(cache.put(request, res.clone()));
    return res;
  },
};
