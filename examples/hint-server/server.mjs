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
import { createHandler } from "./handler.mjs";
import { createDecoder, pollOnce, recoverFromPollError } from "./poll.mjs";
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
  xdr,
} from "@stellar/stellar-sdk";

// ---------- config ----------
const NAMESPACE = (process.env.SORAN_NAMESPACE ?? "").toLowerCase();
if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(NAMESPACE) || NAMESPACE.length > 63) {
  console.error("SORAN_NAMESPACE is required (a canonical namespace label, e.g. acme)");
  process.exit(1);
}
const RPC_URL = process.env.SORAN_RPC_URL ?? "https://soroban-testnet.stellar.org";
// Current live testnet Registry (deploy/testnet/deployment.json). Override for
// another network; never point this at a sealed migration-source Registry.
const REGISTRY_ID =
  process.env.SORAN_REGISTRY_ID || "CCSORANDPQINYOYB5SVO45WJP2LBBYKC72HHUIRVXB4J6RUZKDAUW7G4";
const PASSPHRASE = process.env.SORAN_PASSPHRASE ?? Networks.TESTNET;
const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? "127.0.0.1";
const DATA_FILE = process.env.SORAN_DATA_FILE ?? "./hint-state.json";
const SEED_FILE = process.env.SORAN_SEED_FILE ?? "./seed.json";
const POLL_MS = Math.max(2_000, Number(process.env.SORAN_POLL_MS ?? 10_000));
const MAX_EVENTS_PER_NAME = 100;

const server = new rpc.Server(RPC_URL, { allowHttp: RPC_URL.startsWith("http://") });
// poll() reads raw event pages through the SDK's internal `_getEvents` (the public getEvents fails a whole page on one
// undecodable event). Stop at boot, not on every poll forever, if a newer SDK dropped it.
if (typeof server._getEvents !== "function")
  throw new Error("this @stellar/stellar-sdk has no rpc.Server#_getEvents, which this example reads raw event pages with; install @stellar/stellar-sdk 17.0.1 or update poll() in server.mjs");

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
  if (!Number.isSafeInteger(ledger) || ledger < 0) return;
  const hash = String(txHash ?? "").slice(0, 64);
  const when = String(at ?? "").slice(0, 40);
  const name = `${label}.${NAMESPACE}`;
  state.holders[name] = holder;
  const log = (state.log[name] ??= []);
  if (log.some((e) => e.txHash === hash && e.action === action && e.ledger === ledger)) return;
  log.push({ action, ledger, txHash: hash, at: when });
  log.sort((a, b) => a.ledger - b.ledger);
  if (log.length > MAX_EVENTS_PER_NAME) log.splice(0, log.length - MAX_EVENTS_PER_NAME);
}

async function poll() {
  const registrarId = await resolveRegistrar();
  await pollOnce({
    // The RAW response, decoded event by event: the SDK's getEvents parses the
    // whole page and one undecodable event would fail it forever.
    rpc: { getEvents: (request) => server._getEvents(request), getLatestLedger: () => server.getLatestLedger() },
    filters: [{ type: "contract", contractIds: [registrarId] }],
    state,
    persist,
    decode: createDecoder({ xdr, scValToNative }),
    apply: applyEvent,
    startLedger: Number(process.env.SORAN_START_LEDGER ?? 0),
  });
}
async function pollLoop() {
  for (;;) {
    try {
      await poll();
    } catch (e) {
      // A cursor that fell out of the RPC's event-retention window would fail
      // every future poll: re-anchor at the current ledger (events in the gap
      // are missed, reseed if that matters). Any other failure keeps the cursor
      // and is retried, so a network blip never skips events.
      if (recoverFromPollError(state, e) === "reanchored") {
        console.error(`cursor fell out of the RPC's retention window (${e?.message ?? e}) — re-anchoring at the current ledger; events in the gap are missed`);
        persist();
      } else {
        console.error(`poll failed (will retry from the same cursor): ${e?.message ?? e}`);
      }
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

// ---------- http ----------
const http = createServer(createHandler(
  () => state,
  NAMESPACE,
  (a) => StrKey.isValidEd25519PublicKey(a) || StrKey.isValidContract(a),
));

const registrarId = await resolveRegistrar();
console.log(`hint server for .${NAMESPACE} — registrar ${registrarId}`);
console.log(`state: ${Object.keys(state.holders).length} names, cursor ${state.cursor ? "resumed" : "fresh"}`);
http.listen(PORT, HOST, () => console.log(`listening on http://${HOST}:${PORT}`));
void pollLoop();
