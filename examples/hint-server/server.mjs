/**
 * Soran hint server — self-hostable reference implementation.
 *
 * Serves the discovery endpoints @sorandomains/lookup consumes as its
 * `hintUrl`, for ONE namespace, fed straight from your Registrar's chain
 * events. Run it next to your backend and point the SDK at it:
 *
 *   SORAN_NAMESPACE=acme node server.mjs
 *   new Soran({ hintUrl: "http://localhost:8787" })
 *
 * TRUST MODEL — WHY THIS CAN BE SMALL. A hint server is discovery, not
 * truth: the SDK re-verifies every candidate on chain (`namesOf` checks
 * `holder_of_node`, reverse answers are contract-verified), so a stale,
 * incomplete, or even hostile hint can hide a name by omission but can
 * NEVER forge one. That means: no auth, no database, no consensus duty —
 * a JSON file and an event poller are genuinely enough. The one endpoint
 * that is served as-is is /history, and the SDK labels it informational.
 *
 * WHAT IT DOES
 *   - Polls Soroban RPC `getEvents` for your Registrar's issued /
 *     reclaimed / transfer events (cursor-persisted, restart-safe).
 *   - Maintains name → holder in a JSON state file (atomic writes).
 *   - Serves: /v1/showcase, /v1/names/by-holder/:address,
 *     /v1/reverse/:address, /v1/names/:ns/:label/history, /healthz.
 *
 * BOOTSTRAPPING (the one honest caveat). RPC nodes retain a limited event
 * window (commonly 24h–7d). Names issued before that window won't be
 * discovered from events alone. Two remedies:
 *   - seed.json — `[{ "name": "alice.acme", "holder": "G…" }, …]`. As the
 *     namespace owner you have this list (you issued every name; the
 *     @sorandomains/owner issueBatch outcomes are exactly this shape).
 *     Loaded once at boot for names not already in state; transfers and
 *     reclaims observed later overwrite seeded holders.
 *   - Start the server on day one of a new namespace and it never misses
 *     an event.
 * Wrong or stale entries are harmless to consumers — the SDK's on-chain
 * verification silently drops them.
 *
 * Config (env): SORAN_NAMESPACE (required) · SORAN_REGISTRAR_ID (optional,
 * discovered from the Registry when unset) · SORAN_RPC_URL · SORAN_REGISTRY_ID
 * · PORT (8787) · HOST (127.0.0.1 — set 0.0.0.0 behind a reverse proxy)
 * · SORAN_DATA_FILE (./hint-state.json) · SORAN_SEED_FILE (./seed.json)
 * · SORAN_POLL_MS (10000) · SORAN_START_LEDGER (backfill start; default:
 * follow from the current ledger)
 */

import { createServer } from "node:http";
import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import {
  Account,
  Contract,
  Networks,
  StrKey,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
  hash,
} from "@stellar/stellar-sdk";

// ---------- config ----------
const NAMESPACE = (process.env.SORAN_NAMESPACE ?? "").toLowerCase();
if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(NAMESPACE) || NAMESPACE.length > 63) {
  console.error("SORAN_NAMESPACE is required (a canonical namespace label, e.g. acme)");
  process.exit(1);
}
const RPC_URL = process.env.SORAN_RPC_URL ?? "https://soroban-testnet.stellar.org";
const REGISTRY_ID =
  process.env.SORAN_REGISTRY_ID ?? "CAUEHYVLLNNDZ4H5QWCPBDWEONRI44SI3XYSEACB4U3HYILIVQGQAMNI";
const PASSPHRASE = process.env.SORAN_PASSPHRASE ?? Networks.TESTNET;
const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? "127.0.0.1";
const DATA_FILE = process.env.SORAN_DATA_FILE ?? "./hint-state.json";
const SEED_FILE = process.env.SORAN_SEED_FILE ?? "./seed.json";
const POLL_MS = Math.max(2_000, Number(process.env.SORAN_POLL_MS ?? 10_000));
const MAX_EVENTS_PER_NAME = 100;
const MAX_NAMES_PER_HOLDER = 100;

const server = new rpc.Server(RPC_URL, { allowHttp: RPC_URL.startsWith("http://") });

// ---------- state (name → holder, per-name event log, poll cursor) ----------
/** @type {{ cursor: string | null, lastLedger: number, holders: Record<string,string>, log: Record<string, Array<{action:string,ledger:number,txHash:string,at:string}>> }} */
let state = { cursor: null, lastLedger: 0, holders: {}, log: {} };
if (existsSync(DATA_FILE)) {
  try {
    state = { ...state, ...JSON.parse(readFileSync(DATA_FILE, "utf8")) };
  } catch {
    console.error(`could not parse ${DATA_FILE}; starting fresh`);
  }
}
if (existsSync(SEED_FILE)) {
  try {
    const seed = JSON.parse(readFileSync(SEED_FILE, "utf8"));
    let added = 0;
    for (const row of Array.isArray(seed) ? seed : []) {
      const name = String(row?.name ?? "").toLowerCase();
      const holder = String(row?.holder ?? "");
      if (!name.endsWith(`.${NAMESPACE}`)) continue;
      if (!StrKey.isValidEd25519PublicKey(holder) && !StrKey.isValidContract(holder)) continue;
      if (!(name in state.holders)) {
        state.holders[name] = holder;
        added++;
      }
    }
    if (added) console.log(`seeded ${added} names from ${SEED_FILE}`);
  } catch {
    console.error(`could not parse ${SEED_FILE}; ignoring seed`);
  }
}
function persist() {
  const tmp = `${DATA_FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(state));
  renameSync(tmp, DATA_FILE);
}

// ---------- chain helpers ----------
const SIM_SOURCE = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
async function read(contractId, fn, args) {
  const tx = new TransactionBuilder(new Account(SIM_SOURCE, "0"), {
    fee: "100",
    networkPassphrase: PASSPHRASE,
  })
    .addOperation(new Contract(contractId).call(fn, ...args))
    .setTimeout(30)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (!rpc.Api.isSimulationSuccess(sim) || !sim.result?.retval) return null;
  return scValToNative(sim.result.retval);
}
function namehash(ns) {
  const zero = new Uint8Array(32);
  const label = new Uint8Array(hash(new TextEncoder().encode(ns)));
  const joined = new Uint8Array(64);
  joined.set(zero, 0);
  joined.set(label, 32);
  return new Uint8Array(hash(joined));
}

// ---------- event poller ----------
let REGISTRAR_ID = process.env.SORAN_REGISTRAR_ID ?? null;
async function resolveRegistrar() {
  if (REGISTRAR_ID) return REGISTRAR_ID;
  const id = await read(REGISTRY_ID, "registrar_of", [
    nativeToScVal(namehash(NAMESPACE), { type: "bytes" }),
  ]);
  if (typeof id !== "string") {
    throw new Error(`namespace "${NAMESPACE}" has no attested registrar on ${REGISTRY_ID}`);
  }
  REGISTRAR_ID = id;
  return id;
}

function applyEvent(kind, data, ledger, txHash, at) {
  // issued(label, holder) · reclaimed(label, treasury) · transfer(label, to) —
  // each ends with the name's NEW holder. Other registrar events (renewed,
  // address_set, …) don't change the holder and are ignored here.
  const HOLDER_EVENTS = { issued: "issued", reclaimed: "reclaimed", transfer: "transferred" };
  const action = HOLDER_EVENTS[kind];
  if (!action || !Array.isArray(data) || data.length < 2) return;
  const label = new TextDecoder().decode(data[0]);
  const holder = String(data[1]);
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(label)) return;
  if (!StrKey.isValidEd25519PublicKey(holder) && !StrKey.isValidContract(holder)) return;
  const name = `${label}.${NAMESPACE}`;
  state.holders[name] = holder;
  const log = (state.log[name] ??= []);
  log.push({ action, ledger, txHash, at });
  if (log.length > MAX_EVENTS_PER_NAME) log.splice(0, log.length - MAX_EVENTS_PER_NAME);
}

async function pollOnce() {
  const registrarId = await resolveRegistrar();
  const filters = [{ type: "contract", contractIds: [registrarId] }];
  let request;
  if (state.cursor) request = { filters, cursor: state.cursor, limit: 100 };
  else {
    const start = Number(process.env.SORAN_START_LEDGER ?? 0);
    const latest = await server.getLatestLedger();
    request = { filters, startLedger: start > 0 ? start : latest.sequence, limit: 100 };
  }
  for (;;) {
    const page = await server.getEvents(request);
    for (const ev of page.events ?? []) {
      try {
        const kind = scValToNative(ev.topic[0]);
        applyEvent(kind, scValToNative(ev.value), ev.ledger, ev.txHash, ev.ledgerClosedAt);
        state.lastLedger = ev.ledger;
      } catch {
        /* not an event we understand — skip */
      }
    }
    state.cursor = page.cursor ?? state.cursor;
    persist();
    if (!page.events || page.events.length < 100) break;
    request = { filters, cursor: page.cursor, limit: 100 };
  }
}
async function pollLoop() {
  for (;;) {
    try {
      await pollOnce();
    } catch (e) {
      console.error(`poll failed (will retry): ${e?.message ?? e}`);
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

// ---------- http ----------
function json(res, code, body) {
  const buf = JSON.stringify(body);
  res.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(buf) });
  res.end(buf);
}
const http = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  const parts = url.pathname.split("/").filter(Boolean);

  if (url.pathname === "/healthz") {
    return json(res, 200, {
      ok: true,
      namespace: NAMESPACE,
      names: Object.keys(state.holders).length,
      lastLedger: state.lastLedger,
    });
  }
  if (url.pathname === "/v1/showcase") {
    return json(res, 200, { namespaces: [NAMESPACE] });
  }
  // /v1/names/by-holder/:address
  if (parts.length === 4 && parts[0] === "v1" && parts[1] === "names" && parts[2] === "by-holder") {
    const addr = parts[3];
    if (!StrKey.isValidEd25519PublicKey(addr) && !StrKey.isValidContract(addr)) {
      return json(res, 400, { error: "bad_address" });
    }
    const all = Object.entries(state.holders)
      .filter(([, h]) => h === addr)
      .map(([name]) => ({ name, namespace: NAMESPACE, holder: addr }));
    return json(res, 200, {
      holder: addr,
      names: all.slice(0, MAX_NAMES_PER_HOLDER),
      truncated: all.length > MAX_NAMES_PER_HOLDER,
    });
  }
  // /v1/reverse/:address
  if (parts.length === 3 && parts[0] === "v1" && parts[1] === "reverse") {
    const addr = parts[2];
    const found = Object.entries(state.holders).find(([, h]) => h === addr);
    if (!found) return json(res, 404, { error: "no_name" });
    return json(res, 200, { name: found[0] });
  }
  // /v1/names/:ns/:label/history
  if (
    parts.length === 5 && parts[0] === "v1" && parts[1] === "names" && parts[4] === "history"
  ) {
    const name = `${parts[3]}.${parts[2]}`.toLowerCase();
    const events = state.log[name];
    if (!events && !(name in state.holders)) return json(res, 404, { error: "name_not_found", name });
    const first = events?.find((e) => e.action === "issued");
    return json(res, 200, {
      name,
      // Only what THIS server has witnessed — a from-latest start or seeded
      // name has no issuance event; the platform indexer is the fuller source.
      issuedAt: first?.at ?? "",
      issuedLedger: first?.ledger ?? 0,
      events: [...(events ?? [])].reverse(),
    });
  }
  return json(res, 404, { error: "not_found" });
});

const registrarId = await resolveRegistrar();
console.log(`hint server for .${NAMESPACE} — registrar ${registrarId}`);
console.log(`state: ${Object.keys(state.holders).length} names, cursor ${state.cursor ? "resumed" : "fresh"}`);
http.listen(PORT, HOST, () => console.log(`listening on http://${HOST}:${PORT}`));
void pollLoop();
