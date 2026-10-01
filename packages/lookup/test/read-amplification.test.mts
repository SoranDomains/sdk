import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { Keypair, StrKey, scValToNative, xdr } from "@stellar/stellar-sdk";
import { Soran, SoranError, DEPLOYMENTS } from "../src/index.js";

const C = (n: number) => StrKey.encodeContract(Buffer.alloc(32, n));
const LOOKUP = C(61), REGISTRAR = C(62), RESOLVER = C(63);
const REGISTRY = DEPLOYMENTS.testnet.registryId, G = Keypair.random().publicKey();
const hasher = new Soran({ resolutionMode: "direct" });
const policy = { reclaimable: true, transferable: true, tradeable: true, default_term_secs: 0n, trade_fee_bps: 20 };
const nsNode = await hasher.namehash("nova");
const nsMeta = () => ({ namespace: "nova", node: nsNode, owner: G, registrar: REGISTRAR, resolver: RESOLVER,
  resolver_attested: true, resolver_locked: true, registrar_tainted: false, resolver_tainted: false, permanent: true, policy });
const coverage = { source: "indexed", complete: true, processedLedger: 10, headLedger: 10, gaps: [] };
const labels = (n: number) => Array.from({ length: n }, (_, i) => `n${i}`);

async function fixture(options: Record<string, unknown> = {}, overrides: Record<string, () => unknown> = {}) {
  const calls: string[] = [];
  const s = new Soran({ lookupId: LOOKUP, hintUrl: "https://hint.example", ...options });
  const nodes = new Map<string, Uint8Array>();
  for (const label of labels(100)) nodes.set(`${label}.nova`, await hasher.node(`${label}.nova`));
  Object.assign(s, { read: async (_id: string, fn: string, args: xdr.ScVal[]) => {
    calls.push(fn);
    if (Object.hasOwn(overrides, fn)) return overrides[fn]();
    if (fn === "registry") return REGISTRY;
    if (fn === "version") return 2;
    if (fn === "destination_version") return 2;
    if (fn === "namespace_metadata") return nsMeta();
    if (fn === "text") return "hello";
    if (fn === "name_metadata") {
      const name = String(scValToNative(args[0]));
      return { name, node: nodes.get(name), registrar: REGISTRAR, holder: G, builtin_address: G,
        generation: 18446744073709551615n, expires_at: 0n, active: true, no_expiry: true, namespace_permanent: true };
    }
    throw new Error(`unexpected ${fn}`);
  } });
  return { s, calls };
}
const count = (calls: string[], fn: string) => calls.filter(c => c === fn).length;
const page = (n: number) => ({ holder: G, names: labels(n).map(l => ({ name: `${l}.nova` })), nextCursor: null, hasMore: false, truncated: false, coverage });

test("a holdings page verifies the Lookup anchor once, not once per candidate (SM-05)", async () => {
  const { s, calls } = await fixture();
  Object.assign(s, { hintFetch: async () => page(100) });
  const result = await s.namesOfPage(G, { limit: 100 });
  assert.equal(result.names.length, 100); assert.equal(result.verification.failed, 0);
  assert.equal(count(calls, "name_metadata"), 100);
  for (const fn of ["registry", "version", "destination_version"]) assert.equal(count(calls, fn), 1, `${fn} reads`);
});

test("the shared anchor check is retried after a transient failure instead of failing every later candidate", async () => {
  let failures = 1;
  const { s, calls } = await fixture({}, { registry: () => { if (failures-- > 0) throw new SoranError("blip", "RPC"); return REGISTRY; } });
  // One candidate per pass so the first pass fails alone; the second must re-verify.
  Object.assign(s, { hintFetch: async () => page(1) });
  const first = await s.namesOfPage(G, { limit: 1 });
  assert.equal(first.verification.failed, 1);
  const second = await s.namesOfPage(G, { limit: 1 });
  assert.equal(second.verification.failed, 0); assert.equal(second.names.length, 1);
  assert.equal(count(calls, "registry"), 2);
});

test("a wrong Lookup anchor still fails closed for every candidate", async () => {
  const { s, calls } = await fixture({}, { registry: () => RESOLVER });
  Object.assign(s, { hintFetch: async () => page(5) });
  const result = await s.namesOfPage(G);
  assert.equal(result.names.length, 0); assert.equal(result.verification.failed, 5); assert.equal(result.complete, false);
  assert.equal(count(calls, "name_metadata"), 0);
});

test("concurrent reads share one in-flight anchor check but every later read still verifies fresh", async () => {
  const { s, calls } = await fixture();
  await Promise.all([s.nameMetadata("n1.nova"), s.namespaceMetadata("nova"), s.text("n1.nova", "url")]);
  assert.equal(count(calls, "registry"), 1);
  await s.nameMetadata("n2.nova");
  assert.equal(count(calls, "registry"), 2, "a sequential read must not reuse an earlier verdict");
  await s.nameMetadata("n3.nova");
  assert.equal(count(calls, "registry"), 3);
});

test("profile() and other fan-outs do not multiply anchor checks", async () => {
  const { s, calls } = await fixture();
  await s.profile("n1.nova");
  assert.equal(count(calls, "text"), 8);
  assert.equal(count(calls, "registry"), 1);
});

test("a transient anchor failure at the start of a large page costs at most one worker batch, not the whole page (SM-05)", async () => {
  let failures = 1;
  const { s, calls } = await fixture({}, { registry: () => { if (failures-- > 0) throw new SoranError("blip", "RPC"); return REGISTRY; } });
  Object.assign(s, { hintFetch: async () => page(20) });
  const result = await s.namesOfPage(G, { limit: 20 });
  // The eight in-flight workers shared the failed check; the anchor is dropped, so the next candidate re-verifies for everyone after it.
  assert.ok(result.verification.failed >= 1 && result.verification.failed <= 8, `failed ${result.verification.failed}`);
  assert.equal(result.names.length, 20 - result.verification.failed);
  assert.equal(result.complete, false);
  assert.equal(count(calls, "registry"), 2, "one failed check, one successful re-verification");
});

test("a stalled anchor read does not block later reads on the same instance (SM-05)", async () => {
  mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  try {
    let stall = true;
    const { s, calls } = await fixture({}, { registry: () => (stall ? new Promise(() => {}) : REGISTRY) });
    const first = s.nameMetadata("n1.nova"); // its anchor read never settles (no timeoutMs configured)
    first.catch(() => undefined);
    await new Promise((resolve) => setImmediate(resolve));
    // A fan-out that starts while the check is young still joins it: one anchor read, not two.
    const joiner = s.nameMetadata("n2.nova"); joiner.catch(() => undefined);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(count(calls, "registry"), 1, "a young in-flight verification is shared");
    // Past the join bound the stalled check is presumed dead: a later read verifies for itself and completes.
    mock.timers.tick(5_001);
    stall = false;
    const later = await Promise.race([s.nameMetadata("n3.nova"), new Promise((resolve) => setTimeout(() => resolve("blocked"), 300))]);
    assert.notEqual(later, "blocked", "the read was not stuck behind the stalled verification");
    assert.equal(count(calls, "registry"), 2);
  } finally { mock.timers.reset(); }
});
