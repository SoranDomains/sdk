import assert from "node:assert/strict";
import test from "node:test";
import { createServer, type Server } from "node:http";
import { connect } from "node:net";
import type { AddressInfo } from "node:net";
import { Keypair, StrKey, scValToNative, xdr } from "@stellar/stellar-sdk";
import { Soran, SoranError, DEPLOYMENTS } from "../src/index.js";
// @ts-ignore — plain ESM example, no type declarations
import { createHandler, byHolderPage } from "../../../examples/hint-server/handler.mjs";
// @ts-ignore
import worker, { byHolderPage as workerPage } from "../../../examples/hint-server-cloudflare/worker.mjs";

const G = Keypair.random().publicKey(), OTHER = Keypair.random().publicKey();
const C = (n: number) => StrKey.encodeContract(Buffer.alloc(32, n));
const LOOKUP = C(61), REGISTRAR = C(62);
const isAddress = (a: string) => StrKey.isValidEd25519PublicKey(a) || StrKey.isValidContract(a);
const NS = "nova";
const holders: Record<string, string> = { "zzz.nova": OTHER };
for (let i = 0; i < 7; i++) holders[`n${i}.nova`] = G;
const state = { holders, log: {}, lastLedger: 42 };

const hasher = new Soran({ resolutionMode: "direct" });
const nsNode = await hasher.namehash("nova");
const policy = { reclaimable: true, transferable: true, tradeable: true, default_term_secs: 0n, trade_fee_bps: 20 };
const metaFor = async (name: string) => ({ name, node: await hasher.node(name), registrar: REGISTRAR, holder: G, builtin_address: G,
  generation: 18446744073709551615n, expires_at: 0n, active: true, no_expiry: true, namespace_permanent: true });
function sdkFor(hintUrl: string) {
  const s = new Soran({ lookupId: LOOKUP, hintUrl });
  Object.assign(s, { read: async (_id: string, fn: string, args: xdr.ScVal[]) => {
    if (fn === "registry") return DEPLOYMENTS.testnet.registryId;
    if (fn === "version") return 1;
    if (fn === "name_metadata") return metaFor(String(scValToNative(args[0])));
    throw new Error(`unexpected ${fn}`);
  } });
  return s;
}
async function listen(): Promise<{ server: Server; url: string }> {
  const server = createServer(createHandler(() => state, NS, isAddress));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

test("Node hint server by-holder output passes the SDK's namesOfPage validation and paginates", async () => {
  const { server, url } = await listen();
  try {
    const s = sdkFor(url);
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 10; i++) {
      const page = await s.namesOfPage(G, { limit: 3, cursor });
      assert.ok(page.names.length <= 3);
      assert.equal(page.verification.failed, 0);
      assert.equal(page.complete, false, "a one-namespace hint server cannot attest completeness");
      seen.push(...page.names.map((n) => n.name));
      if (!page.hasMore) break;
      cursor = page.nextCursor!;
    }
    assert.deepEqual(seen.sort(), [0, 1, 2, 3, 4, 5, 6].map((i) => `n${i}.nova`));
    const res = await fetch(`${url}/v1/names/by-holder/${G}?limit=101`);
    assert.equal(res.status, 400);
    assert.equal((await fetch(`${url}/v1/names/by-holder/${G}?limit=0`)).status, 400);
  } finally { server.close(); }
});

test("a malformed request target returns 400 and the server keeps serving (no process crash)", async () => {
  const { server, url } = await listen();
  try {
    const port = Number(new URL(url).port);
    for (const target of ["//", "///x", "//%"]) {
      const reply = await new Promise<string>((resolve, reject) => {
        const sock = connect(port, "127.0.0.1", () => sock.write(`GET ${target} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`));
        let out = ""; sock.on("data", (d) => (out += d)); sock.on("end", () => resolve(out)); sock.on("error", reject);
      });
      assert.match(reply, /^HTTP\/1\.1 (400|404)/, target);
    }
    assert.equal((await fetch(`${url}/healthz`)).status, 200);
  } finally { server.close(); }
});

test("the handler contains an unexpected throw as a 400", async () => {
  const server = createServer(createHandler(() => { throw new Error("boom"); }, NS, isAddress));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/healthz`);
    assert.equal(res.status, 400);
  } finally { server.close(); }
});

test("Cloudflare worker by-holder page matches the Node page and survives bad requests", async () => {
  assert.deepEqual(workerPage(state, NS, G, "3", null), byHolderPage(state, NS, G, "3", null));
  (globalThis as any).caches = { default: { match: async () => undefined, put: async () => {} } };
  const env = { SORAN_NAMESPACE: NS, HINT_KV: { get: async () => JSON.stringify(state) } };
  const ctx = { waitUntil: () => {} };
  const res = await worker.fetch(new Request(`https://h.example/v1/names/by-holder/${G}?limit=2`), env, ctx);
  const body = await res.json();
  assert.equal(body.names.length, 2); assert.equal(body.hasMore, true); assert.equal(typeof body.nextCursor, "string");
  assert.equal((await worker.fetch(new Request(`https://h.example/v1/names/by-holder/${G}?limit=nope`), env, ctx)).status, 400);
  const broken = { ...env, HINT_KV: { get: async () => { throw new Error("kv down"); } } };
  assert.equal((await worker.fetch(new Request(`https://h.example/healthz`), broken, ctx)).status, 400);
  // A fake request whose URL cannot be parsed must not throw.
  assert.equal((await worker.fetch({ url: "//", method: "GET" } as any, env, ctx)).status, 400);
});

test("history() sanitises hostile issuedAt/issuedLedger", async () => {
  const s = sdkFor("https://example.invalid");
  Object.assign(s, { hintFetch: async () => ({ issuedAt: { x: 1 }, issuedLedger: 1e400, events: [] }) });
  const h = await s.history("alice.nova");
  assert.equal(h.issuedAt, ""); assert.equal(h.issuedLedger, 0);
  Object.assign(s, { hintFetch: async () => ({ issuedAt: "x".repeat(500), issuedLedger: -5, events: [] }) });
  const h2 = await s.history("alice.nova");
  assert.equal(h2.issuedAt.length, 40); assert.equal(h2.issuedLedger, 0);
  assert.ok(SoranError);
});
