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
 * Vars (wrangler.toml): SORAN_NAMESPACE, SORAN_REGISTRAR_ID (both required),
 * SORAN_RPC_URL (default: testnet public RPC), SORAN_START_LEDGER (optional
 * backfill start — must be within your RPC's event retention).
 * Binding: HINT_KV (KV namespace).
 *
 * Seeding names older than the RPC event-retention window: put a JSON array
 * under KV key "seed" — [{ "name": "alice.acme", "holder": "G…" }, …] — and
 * it is merged once on the next cron run (see README).
 */

const LABEL_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
// Hint-grade address check (length + alphabet). Full strkey checksum
// validation is deliberately omitted: the SDK re-verifies on chain, so a
// mistyped seed entry costs a wasted probe, never a wrong answer.
const ADDR_RE = /^[GC][A-Z2-7]{55}$/;
const MAX_EVENTS_PER_NAME = 100;
const MAX_NAMES_PER_HOLDER = 100;
const MAX_PAGES_PER_RUN = 5; // stay well under the per-invocation subrequest cap

const HOLDER_EVENTS = { issued: "issued", reclaimed: "reclaimed", transfer: "transferred" };

function hexToUtf8(hex) {
  if (typeof hex !== "string" || hex.length % 2 !== 0 || /[^0-9a-fA-F]/.test(hex)) return null;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return new TextDecoder().decode(bytes);
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
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

const EMPTY_STATE = { cursor: null, lastLedger: 0, seedApplied: false, holders: {}, log: {} };

async function loadState(env) {
  const raw = await env.HINT_KV.get("state");
  if (!raw) return { ...EMPTY_STATE };
  try {
    return { ...EMPTY_STATE, ...JSON.parse(raw) };
  } catch {
    return { ...EMPTY_STATE };
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
  const name = `${label}.${namespace}`;
  state.holders[name] = holder;
  const log = (state.log[name] ??= []);
  // Idempotent under cron overlap / cursor replay: the same chain event must
  // not append twice.
  if (log.some((e) => e.txHash === txHash && e.action === action && e.ledger === ledger)) return;
  log.push({ action, ledger, txHash, at });
  if (log.length > MAX_EVENTS_PER_NAME) log.splice(0, log.length - MAX_EVENTS_PER_NAME);
}

async function poll(env) {
  const namespace = (env.SORAN_NAMESPACE ?? "").toLowerCase();
  const registrarId = env.SORAN_REGISTRAR_ID ?? "";
  if (!LABEL_RE.test(namespace) || !/^C[A-Z2-7]{55}$/.test(registrarId)) {
    throw new Error("configure SORAN_NAMESPACE and SORAN_REGISTRAR_ID (wrangler.toml [vars])");
  }
  const rpcUrl = env.SORAN_RPC_URL ?? "https://soroban-testnet.stellar.org";
  const state = await loadState(env);

  // One-time seed merge (names older than the RPC event-retention window).
  if (!state.seedApplied) {
    try {
      const seed = JSON.parse((await env.HINT_KV.get("seed")) ?? "[]");
      for (const row of Array.isArray(seed) ? seed : []) {
        const name = String(row?.name ?? "").toLowerCase();
        const holder = String(row?.holder ?? "");
        if (!name.endsWith(`.${namespace}`) || !ADDR_RE.test(holder)) continue;
        if (!(name in state.holders)) state.holders[name] = holder;
      }
    } catch {
      /* malformed seed — ignore; chain events remain authoritative */
    }
    state.seedApplied = true;
  }

  const filters = [{ type: "contract", contractIds: [registrarId] }];
  for (let page = 0; page < MAX_PAGES_PER_RUN; page++) {
    const params = state.cursor
      ? { filters, pagination: { cursor: state.cursor, limit: 100 }, xdrFormat: "json" }
      : {
          startLedger:
            Number(env.SORAN_START_LEDGER ?? 0) > 0
              ? Number(env.SORAN_START_LEDGER)
              : (await rpcCall(rpcUrl, "getLatestLedger", {})).sequence,
          filters,
          pagination: { limit: 100 },
          xdrFormat: "json",
        };
    const result = await rpcCall(rpcUrl, "getEvents", params);
    for (const ev of result.events ?? []) {
      const kind = ev.topicJson?.[0]?.symbol;
      applyEvent(state, namespace, kind, ev.valueJson, ev.ledger, ev.txHash, ev.ledgerClosedAt);
      state.lastLedger = ev.ledger;
    }
    state.cursor = result.cursor ?? state.cursor;
    if (!result.events || result.events.length < 100) break;
  }
  await env.HINT_KV.put("state", JSON.stringify(state));
  return state;
}

export default {
  /** Cron Trigger: index new chain events into KV. */
  async scheduled(_event, env, ctx) {
    // Surface failures in `wrangler tail` — an unhandled rejection inside
    // waitUntil is reported as an opaque internal error otherwise.
    ctx.waitUntil(
      poll(env).catch((e) => console.error(`poll failed (next cron retries): ${e?.message ?? e}`)),
    );
  },

  /** HTTP: serve the hint contract from the KV index. */
  async fetch(request, env) {
    const namespace = (env.SORAN_NAMESPACE ?? "").toLowerCase();
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);
    const state = await loadState(env);

    if (url.pathname === "/healthz") {
      return json({
        ok: true,
        namespace,
        names: Object.keys(state.holders).length,
        lastLedger: state.lastLedger,
      });
    }
    if (url.pathname === "/v1/showcase") return json({ namespaces: [namespace] });

    if (parts.length === 4 && parts[0] === "v1" && parts[1] === "names" && parts[2] === "by-holder") {
      const addr = parts[3];
      if (!ADDR_RE.test(addr)) return json({ error: "bad_address" }, 400);
      const all = Object.entries(state.holders)
        .filter(([, h]) => h === addr)
        .map(([name]) => ({ name, namespace, holder: addr }));
      return json({
        holder: addr,
        names: all.slice(0, MAX_NAMES_PER_HOLDER),
        truncated: all.length > MAX_NAMES_PER_HOLDER,
      });
    }
    if (parts.length === 3 && parts[0] === "v1" && parts[1] === "reverse") {
      const found = Object.entries(state.holders).find(([, h]) => h === parts[2]);
      return found ? json({ name: found[0] }) : json({ error: "no_name" }, 404);
    }
    if (parts.length === 5 && parts[0] === "v1" && parts[1] === "names" && parts[4] === "history") {
      const name = `${parts[3]}.${parts[2]}`.toLowerCase();
      const events = state.log[name];
      if (!events && !(name in state.holders)) return json({ error: "name_not_found", name }, 404);
      const first = events?.find((e) => e.action === "issued");
      return json({
        name,
        // Only what THIS worker has witnessed — seeded/pre-retention names
        // have no issuance event here; the platform indexer is fuller.
        issuedAt: first?.at ?? "",
        issuedLedger: first?.ledger ?? 0,
        events: [...(events ?? [])].reverse(),
      });
    }
    return json({ error: "not_found" }, 404);
  },
};
