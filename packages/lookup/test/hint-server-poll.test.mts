import assert from "node:assert/strict";
import test from "node:test";
import { Address, Keypair, StrKey, rpc, scValToNative, xdr } from "@stellar/stellar-sdk";
// @ts-ignore — plain ESM example, no type declarations
import { createDecoder, decodePage, isRetentionError, pollOnce, recoverFromPollError } from "../../../examples/hint-server/poll.mjs";
// @ts-ignore
import worker, { isRetentionError as workerIsRetentionError } from "../../../examples/hint-server-cloudflare/worker.mjs";

const RETENTION = "getEvents: startLedger must be within the ledger range: 4900000 - 5020000";
const TRANSIENT = ["fetch failed", "getEvents: HTTP 503", "Unexpected token < in JSON at position 0", "socket hang up", "getEvents: rate limited", "ECONNRESET"];

test("only the RPC's retention-window error counts as a lost cursor (both examples)", () => {
  for (const check of [isRetentionError, workerIsRetentionError]) {
    assert.equal(check(new Error(RETENTION)), true);
    assert.equal(check(new Error("startLedger must be within the ledger range: 1 – 2")), true);
    assert.equal(check(RETENTION), true);
    for (const message of TRANSIENT) assert.equal(check(new Error(message)), false, message);
    assert.equal(check(undefined), false);
  }
});

test("a transient poll error keeps the cursor; a retention error re-anchors (Node example)", () => {
  for (const message of TRANSIENT) {
    const state = { cursor: "0000123-1", lastLedger: 5 } as { cursor: string | null; lastLedger: number };
    assert.equal(recoverFromPollError(state, new Error(message)), "retry");
    assert.equal(state.cursor, "0000123-1", message);
  }
  const lost = { cursor: "0000123-1" } as { cursor: string | null };
  assert.equal(recoverFromPollError(lost, new Error(RETENTION)), "reanchored");
  assert.equal(lost.cursor, null);
  const fresh = { cursor: null } as { cursor: string | null };
  assert.equal(recoverFromPollError(fresh, new Error(RETENTION)), "retry", "nothing to drop without a cursor");
});

const G = Keypair.random().publicKey();
const raw = (label: string, id: string, ledger: number) => ({ id, ledger, txHash: id.replace(/\D/g, "").padEnd(64, "0"), ledgerClosedAt: "2026-09-30T00:00:00Z",
  topic: [xdr.ScVal.scvSymbol("issued").toXDR("base64")],
  value: xdr.ScVal.scvVec([xdr.ScVal.scvBytes(Buffer.from(label)), new Address(G).toScVal()]).toXDR("base64") });
const undecodable = (id: string, ledger: number) => ({ id, ledger, txHash: "0".repeat(64), topic: ["AAAA"], value: "not-xdr" });
const decode = createDecoder({ xdr, scValToNative });

test("one undecodable event is isolated and reported; the rest of the page is applied (AI-12)", () => {
  const page = [raw("alice", "0000001-1", 1), undecodable("0000002-1", 2), raw("bob", "0000003-1", 3)];
  const { decoded, undecodable: bad } = decodePage(page, decode);
  assert.deepEqual(decoded.map((e: any) => [e.kind, e.ledger]), [["issued", 1], ["issued", 3]]);
  assert.equal(bad.length, 1); assert.equal(bad[0].id, "0000002-1"); assert.equal(bad[0].ledger, 2); assert.ok(bad[0].reason.length > 0);
  assert.deepEqual(decodePage(undefined, decode), { decoded: [], undecodable: [] });
  // Hostile ids and reasons are clamped before they reach persisted state.
  const [huge] = decodePage([{ id: "x".repeat(1000), ledger: "nope", topic: [], value: "" }], decode).undecodable;
  assert.ok(huge.id.length <= 64 && huge.ledger === null && huge.reason.length <= 120);
});

test("premise: the SDK's own page parser fails the whole page on one undecodable event", async () => {
  const server = new rpc.Server("https://rpc.example");
  (server as any)._getEvents = async () => ({ latestLedger: 3, cursor: "0000003-1", events: [raw("alice", "0000001-1", 1), undecodable("0000002-1", 2)] });
  await assert.rejects(server.getEvents({ filters: [] }), "if this now succeeds, the raw-page workaround in the Node example can go");
  assert.equal((await (server as any)._getEvents()).events.length, 2, "the raw response is still available for per-event decoding");
});

test("the Node example's raw page read is the SDK's own `_getEvents`, present on the real class and reached by getEvents (AI-12)", async () => {
  // examples/hint-server/server.mjs calls the underscore-prefixed method so one undecodable event cannot fail a page. The premise
  // test above stubs it on an INSTANCE, which passes whatever the SDK ships; this pins the real prototype, so a later SDK 17.x that
  // renames or reshapes it fails here instead of leaving the example failing every poll.
  const proto = rpc.Server.prototype as unknown as Record<string, unknown>;
  assert.equal(typeof proto._getEvents, "function", "rpc.Server#_getEvents is gone: update server.mjs (or pin the example's SDK)");
  const original = proto._getEvents;
  const seen: unknown[] = [];
  proto._getEvents = async (request: unknown) => { seen.push(request); return { latestLedger: 1, cursor: "0000001-1", events: [] }; };
  try {
    const request = { filters: [{ type: "contract" as const, contractIds: [StrKey.encodeContract(Buffer.alloc(32, 9))] }], cursor: "0000123-1", limit: 100 };
    await new rpc.Server("https://rpc.example").getEvents(request);
    assert.deepEqual(seen, [request], "getEvents is a thin parser over _getEvents, so the raw call takes the same request");
  } finally { proto._getEvents = original; }
});

test("pollOnce survives an undecodable event, advances the cursor and surfaces the count (AI-12)", async () => {
  const state: any = { cursor: null, lastLedger: 0, holders: {}, log: {} };
  const applied: string[] = [];
  let persisted = 0;
  const pages = [{ cursor: "0000003-1", events: [raw("alice", "0000001-1", 1), undecodable("0000002-1", 2), raw("bob", "0000003-1", 3)] }];
  await pollOnce({
    rpc: { getEvents: async () => pages.shift(), getLatestLedger: async () => ({ sequence: 1 }) }, filters: [], state, persist: () => { persisted++; }, decode, startLedger: 1,
    apply: (kind: string, data: unknown[], ledger: number) => { applied.push(`${kind}:${new TextDecoder().decode(data[0] as Uint8Array)}@${ledger}`); },
  });
  assert.deepEqual(applied, ["issued:alice@1", "issued:bob@3"]);
  assert.equal(state.cursor, "0000003-1"); assert.equal(state.lastLedger, 3); assert.ok(persisted >= 1);
  assert.equal(state.undecodable, 1); assert.deepEqual(state.lastUndecodable.map((e: any) => e.id), ["0000002-1"]);
});

test("pollOnce keeps paging on full pages and lets transport errors propagate with the cursor intact", async () => {
  const state: any = { cursor: "0000009-1", lastLedger: 9, holders: {}, log: {} };
  const requests: any[] = [];
  const full = { cursor: "0000010-1", events: Array.from({ length: 2 }, (_, i) => raw(`n${i}`, `000001${i}-1`, 10 + i)) };
  await pollOnce({ rpc: { getEvents: async (request: any) => { requests.push(request); return requests.length === 1 ? full : { cursor: "0000011-1", events: [] }; }, getLatestLedger: async () => ({ sequence: 1 }) },
    filters: [], state, persist: () => {}, decode, startLedger: 1, apply: () => {}, pageLimit: 2 });
  assert.deepEqual(requests.map(r => r.cursor), ["0000009-1", "0000010-1"]);
  assert.equal(state.cursor, "0000011-1");
  await assert.rejects(pollOnce({ rpc: { getEvents: async () => { throw new Error("getEvents: HTTP 503"); }, getLatestLedger: async () => ({ sequence: 1 }) },
    filters: [], state, persist: () => {}, decode, startLedger: 1, apply: () => {} }), /503/);
  assert.equal(state.cursor, "0000011-1");
});

/** The Cloudflare edition against an in-memory KV and a scripted RPC. */
async function runCron(initial: Record<string, unknown>, rpcError: string | number) {
  const kv = new Map<string, string>([["state", JSON.stringify(initial)]]);
  const env = { SORAN_NAMESPACE: "acme", SORAN_REGISTRAR_ID: "C" + "A".repeat(55), SORAN_RPC_URL: "https://rpc.example",
    HINT_KV: { get: async (key: string) => kv.get(key) ?? null, put: async (key: string, value: string) => { kv.set(key, value); } } };
  const saved = globalThis.fetch, saw: string[] = [];
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    const method = JSON.parse(String(init.body)).method;
    saw.push(method);
    return typeof rpcError === "number" ? new Response("bad gateway", { status: rpcError }) : Response.json({ jsonrpc: "2.0", id: 1, error: { message: rpcError } });
  }) as never;
  const pending: Promise<unknown>[] = [];
  try {
    await worker.scheduled({}, env, { waitUntil: (p: Promise<unknown>) => { pending.push(p); } });
    await Promise.all(pending);
  } finally { globalThis.fetch = saved; }
  return { state: JSON.parse(kv.get("state")!), saw };
}
const cronState = { cursor: "0000123-1", anchorLedger: 0, lastLedger: 100, gaps: 0, lastError: null, lastWriteAt: "", holders: { "alice.acme": G }, log: {} };

test("Cloudflare edition: a transient RPC error keeps the cursor and the holders (SM-12)", async () => {
  for (const failure of [503, "rate limited", "internal error"]) {
    const { state, saw } = await runCron(cronState, failure);
    assert.deepEqual(saw, ["getEvents"]);
    assert.equal(state.cursor, "0000123-1", String(failure));
    assert.equal(state.gaps, 0); assert.equal(state.holders["alice.acme"], G);
    assert.match(state.lastError, /getEvents/);
  }
});

test("Cloudflare edition: a cursor that fell out of retention re-anchors and counts the gap", async () => {
  const { state } = await runCron(cronState, RETENTION.replace("getEvents: ", ""));
  assert.equal(state.cursor, null); assert.equal(state.gaps, 1); assert.match(state.lastError, /re-anchored/);
  assert.equal(state.holders["alice.acme"], G);
});
