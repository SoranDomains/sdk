import assert from "node:assert/strict";
import test from "node:test";
import { Keypair, StrKey, scValToNative, xdr } from "@stellar/stellar-sdk";
import { Soran, SoranError, DEPLOYMENTS, normalizeLabel, parseName } from "../src/index.js";

const C = (n: number) => StrKey.encodeContract(Buffer.alloc(32, n));
const LOOKUP = C(61), REGISTRAR = C(62), RESOLVER = C(63), PRIMARY = C(64), CUSTOM = C(65);
const REGISTRY = DEPLOYMENTS.testnet.registryId, G = Keypair.random().publicKey();
const hasher = new Soran({ resolutionMode: "direct" });
const nsNode = await hasher.namehash("nova"), nameNode = await hasher.node("alice.nova");
const policy = { reclaimable: true, transferable: true, tradeable: true, default_term_secs: 0n, trade_fee_bps: 20 };
const ns = () => ({ namespace: "nova", node: nsNode, owner: G, registrar: REGISTRAR, resolver: RESOLVER,
  resolver_attested: true, resolver_locked: true, registrar_tainted: false, resolver_tainted: false, permanent: true, policy });
const meta = () => ({ name: "alice.nova", node: nameNode, registrar: REGISTRAR, holder: G, builtin_address: G,
  generation: 18446744073709551615n, expires_at: 0n, active: true, no_expiry: true, namespace_permanent: true });
const resolution = () => ({ name: "alice.nova", registrar: REGISTRAR, resolver: RESOLVER, generation: 18446744073709551615n,
  result: ["NativePayment", { address: G, memo: ["Id", 7n] }] });
function fixture(overrides: Record<string, unknown> = {}, options: Record<string, unknown> = {}) {
  const calls: Array<{ id: string; fn: string; args: xdr.ScVal[] }> = [];
  const s = new Soran({ lookupId: LOOKUP, ...options });
  Object.assign(s, { read: async (id: string, fn: string, args: xdr.ScVal[]) => {
    calls.push({ id, fn, args }); assert.equal(id, LOOKUP, "unexpected direct contract call");
    if (Object.hasOwn(overrides, fn)) { const value = overrides[fn]; if (value instanceof Error) throw value; return value; }
    if (fn === "registry") return REGISTRY;
    if (fn === "version") return 1;
    if (fn === "namespace_metadata") return ns();
    if (fn === "name_metadata") return meta();
    if (fn === "resolve") return resolution();
    if (fn === "text") return "hello";
    if (fn === "reverse" || fn === "primary_name") return "alice.nova";
    if (fn === "primary") return PRIMARY;
    throw new Error(`unexpected function ${fn}`);
  } });
  return { s, calls };
}
const code = (value: string) => (error: unknown) => error instanceof SoranError && error.code === value;

test("ASCII normalization precedes lowercasing and rejects Unicode aliases", async () => {
  assert.equal(normalizeLabel("NoVA"), "nova");
  assert.deepEqual(parseName("ALICE.NOVA"), { label: "alice", namespace: "nova" });
  for (const value of ["K.nova", "a.K", "ａ.nova", "é.nova", " alice.nova", "alice.nova.", "a..nova", "a".repeat(64) + ".nova"])
    assert.throws(() => parseName(value), code("INVALID_INPUT"));
  const { s, calls } = fixture();
  await assert.rejects(s.lookup("K.nova"), code("INVALID_INPUT"));
  await assert.rejects(s.reverse("K", G), code("INVALID_INPUT"));
  assert.equal(calls.length, 0);
  assert.deepEqual(await s.namehash("NOVA"), nsNode);
});
test("universal is the default; a custom unpinned deployment never falls back", async () => {
  const s = new Soran({ registryId: CUSTOM });
  let reads = 0; Object.assign(s, { read: async () => { reads++; throw new Error("must not read"); } });
  for (const run of [() => s.resolvePayment("alice.nova"), () => s.text("alice.nova", "url"), () => s.namespace("nova"), () => s.reverse("nova", G), () => s.primaryOf(G)])
    await assert.rejects(run(), code("CONFIG"));
  assert.equal(reads, 0);
  assert.throws(() => new Soran({ resolutionMode: "direct", lookupId: LOOKUP }), code("CONFIG"));
  assert.throws(() => new Soran({ resolutionMode: "universal", lookupId: null }), code("CONFIG"));
});
test("a configured real network preset selects universal reads by default", async () => {
  const preset = DEPLOYMENTS.testnet as unknown as { lookupId?: string };
  const previous = preset.lookupId;
  try {
    preset.lookupId = LOOKUP;
    const { s: source } = fixture();
    const s = new Soran();
    Object.assign(s, { read: (source as unknown as { read: unknown }).read });
    assert.equal((await s.lookup("alice.nova")).kind, "nativePayment");
  } finally { if (previous === undefined) delete preset.lookupId; else preset.lookupId = previous; }
});
test("forward, metadata, profiles, assurance, scoped reverse and Primary all use Lookup", async () => {
  const { s, calls } = fixture();
  assert.equal((await s.namespaceMetadata("NOVA"))?.policy?.defaultTermSecs, 0n);
  assert.equal((await s.nameMetadata("ALICE.NOVA"))?.generation, 18446744073709551615n);
  assert.equal((await s.details("alice.nova")).payment?.memo.type, "id");
  assert.equal((await s.assurance("alice.nova")).trustworthy, true);
  assert.equal(await s.reverse("NOVA", G), "alice.nova");
  assert.equal(await s.reverseVerify(G, "alice.nova"), true);
  assert.equal(await s.reverseLookup(G, ["nova"]), "alice.nova");
  assert.equal((await s.reverseNames(G, ["nova"]))[0].primary, true);
  assert.equal(await s.primaryOf(G), "alice.nova");
  assert.equal((await s.profile("alice.nova")).url, "hello");
  assert.equal((await s.identity("alice.nova")).details.holder, G);
  assert.ok(calls.every(c => c.id === LOOKUP));
  for (const c of calls.filter(c => ["resolve", "name_metadata", "text"].includes(c.fn))) assert.equal(scValToNative(c.args[0]), "alice.nova");
});
test("metadata and text errors do not select direct fallback", async () => {
  for (const fn of ["namespace_metadata", "name_metadata", "text", "reverse", "primary_name"]) {
    const error = new SoranError("dependency unavailable", "SIMULATION");
    const { s, calls } = fixture({ [fn]: error });
    const run = fn === "namespace_metadata" ? () => s.namespace("nova") : fn === "name_metadata" ? () => s.nameMetadata("alice.nova") : fn === "text" ? () => s.text("alice.nova", "url") : fn === "reverse" ? () => s.reverse("nova", G) : () => s.primaryOf(G);
    await assert.rejects(run(), e => e === error);
    assert.ok(calls.every(c => c.id === LOOKUP));
  }
});
test("namespace assurance retains attestation, lock and taint gates", async () => {
  for (const change of [{ resolver_attested: false }, { resolver_locked: false }, { resolver_tainted: true }]) {
    const { s } = fixture({ namespace_metadata: { ...ns(), ...change } });
    assert.equal((await s.assurance("alice.nova")).trustworthy, false);
  }
});
test("metadata validates exact shape, canonical context, u64, addresses and boolean fields", async () => {
  for (const change of [{ extra: true }, { name: "bob.nova" }, { node: new Uint8Array(32) }, { registrar: G }, { holder: "bad" },
    { generation: 1 }, { expires_at: -1n }, { active: 1 }, { no_expiry: false }]) {
    const { s } = fixture({ name_metadata: { ...meta(), ...change } });
    await assert.rejects(s.nameMetadata("alice.nova"), code("ABI"));
  }
  for (const change of [{ namespace: "NOVA" }, { resolver: G }, { resolver_locked: 1 }, { policy: { ...policy, trade_fee_bps: 10001 } }, { policy: { ...policy, default_term_secs: 0 } }]) {
    const { s } = fixture({ namespace_metadata: { ...ns(), ...change } });
    await assert.rejects(s.namespaceMetadata("nova"), code("ABI"));
  }
  const empty = fixture({ name_metadata: null, namespace_metadata: null }).s;
  assert.equal(await empty.nameMetadata("alice.nova"), null);
  assert.equal(await empty.namespace("nova"), null);
});
test("details rejects mixed generations instead of labeling a changed payment as one metadata snapshot", async () => {
  const { s } = fixture({ name_metadata: { ...meta(), generation: 1n } });
  await assert.rejects(s.details("alice.nova"), code("SIMULATION"));
});
test("text is bounded by UTF-8 bytes and reverse/Primary names must be canonical", async () => {
  assert.equal(await fixture({ text: "😀".repeat(1024) }).s.text("alice.nova", "url"), "😀".repeat(1024));
  for (const value of ["😀".repeat(1025), 7]) await assert.rejects(fixture({ text: value }).s.text("alice.nova", "url"), code("ABI"));
  for (const name of ["ALICE.NOVA", "K.nova", "a..nova", 7]) {
    await assert.rejects(fixture({ primary_name: name }).s.primaryOf(G), code("ABI"));
    await assert.rejects(fixture({ reverse: name }).s.reverse("nova", G), code("ABI"));
  }
  await assert.rejects(fixture({ reverse: "alice.other" }).s.reverse("nova", G), code("ABI"));
  assert.equal(await fixture({}, { primaryId: null }).s.primaryOf(G), null);
  await assert.rejects(fixture({}, { primaryId: CUSTOM }).s.primaryOf(G), code("CONFIG"));
});
test("direct Primary validates Registry and canonical result before displaying it", async () => {
  const s = new Soran({ resolutionMode: "direct", primaryId: PRIMARY });
  let anchor = REGISTRY, result: unknown = "alice.nova";
  const calls: string[] = [];
  Object.assign(s, { read: async (_id: string, fn: string) => { calls.push(fn); return fn === "registry" ? anchor : result; } });
  assert.equal(await s.primaryOf(G), "alice.nova");
  anchor = CUSTOM; calls.length = 0;
  await assert.rejects(s.primaryOf(G), code("CONFIG")); assert.deepEqual(calls, ["registry"]);
  anchor = REGISTRY;
  for (result of ["ALICE.NOVA", "K.nova", "bad", 4]) await assert.rejects(s.primaryOf(G), code("ABI"));
});
test("known top-level Lookup contract failures have structured codes; inner traces and unknown codes do not", async () => {
  for (const [error, expected] of [["HostError: Error(Contract, #19)", 19], ["Error(Contract, #5)\ntrace", 5], ["outer failure\nError(Contract, #5)", null], ["Error(Contract, #999)", null]] as const) {
    const s = new Soran({ lookupId: LOOKUP });
    Object.assign(s, { server: { simulateTransaction: async () => ({ error }) } });
    await assert.rejects(s.lookup("alice.nova"), (e: unknown) => e instanceof SoranError && e.code === "SIMULATION" && e.contractCode === expected && (expected === null ? e.contractError === null : typeof e.contractError === "string"));
  }
});

const coverage = { source: "indexed", complete: true, processedLedger: 10, headLedger: 10, gaps: [] };
const page = (overrides = {}) => ({ holder: G, names: [{ name: "alice.nova" }], nextCursor: null, hasMore: false, truncated: false, coverage, ...overrides });
test("holdings pagination preserves continuation/coverage and verifies through name metadata only", async () => {
  const { s, calls } = fixture({}, { hintUrl: "https://example.invalid" });
  const paths: string[] = [];
  Object.assign(s, { hintFetch: async (path: string) => { paths.push(path); return page({ nextCursor: "cursor+one", hasMore: true, truncated: true }); } });
  const result = await s.namesOfPage(G, { cursor: "opaque+/", limit: 1 });
  assert.equal(result.names[0].holder, G); assert.equal(result.nextCursor, "cursor+one"); assert.equal(result.complete, false);
  assert.deepEqual(result.coverage, coverage); assert.equal(result.verification.failed, 0);
  assert.ok(paths[0].includes("cursor=opaque%2B%2F"));
  assert.ok(calls.every(c => ["registry", "version", "name_metadata"].includes(c.fn)));
});
test("holdings never hide failed verification or missing/gapped coverage", async () => {
  const { s } = fixture({ name_metadata: new SoranError("cold", "ARCHIVED") }, { hintUrl: "https://example.invalid" });
  Object.assign(s, { hintFetch: async () => page() });
  const result = await s.namesOfPage(G);
  assert.equal(result.names.length, 0); assert.equal(result.verification.failed, 1); assert.equal(result.complete, false);
  await assert.rejects(s.namesOf(G), code("INCOMPLETE"));
  const good = fixture({}, { hintUrl: "https://example.invalid" }).s;
  for (const cov of [null, { ...coverage, complete: false }, { ...coverage, gaps: [{ contractId: RESOLVER, fromLedger: 1, toLedger: 2, reason: "missed" }] }]) {
    Object.assign(good, { hintFetch: async () => page({ coverage: cov }) });
    assert.equal((await good.namesOfPage(G)).complete, false);
  }
});
test("holdings excludes no-longer-held candidates and rejects malformed page controls", async () => {
  const { s } = fixture({ name_metadata: { ...meta(), holder: CUSTOM } }, { hintUrl: "https://example.invalid" });
  Object.assign(s, { hintFetch: async () => page() });
  const result = await s.namesOfPage(G); assert.equal(result.verification.excluded, 1); assert.equal(result.names.length, 0);
  for (const bad of [page({ holder: CUSTOM }), page({ hasMore: true }), page({ nextCursor: "" }), page({ names: [null, null] })]) {
    Object.assign(s, { hintFetch: async () => bad });
    await assert.rejects(s.namesOfPage(G, { limit: 1 }), code("ABI"));
  }
});
test("compatibility holdings array follows cursors and rejects loops", async () => {
  const { s } = fixture({}, { hintUrl: "https://example.invalid" });
  let reads = 0;
  Object.assign(s, { hintFetch: async () => ++reads === 1 ? page({ nextCursor: "next", hasMore: true }) : page() });
  assert.equal((await s.namesOf(G)).length, 1); assert.equal(reads, 2);
  Object.assign(s, { hintFetch: async () => page({ nextCursor: "same", hasMore: true }) });
  await assert.rejects(s.namesOf(G), code("ABI"));
});
