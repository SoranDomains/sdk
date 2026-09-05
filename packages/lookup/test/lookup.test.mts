import assert from "node:assert/strict";
import test from "node:test";
import { Keypair, StrKey, nativeToScVal, scValToNative, xdr } from "@stellar/stellar-sdk";
import { DEPLOYMENTS, Soran, SoranError, type LookupResult, type SoranOptions } from "../src/index.js";
import { paymentMemoToScVal, type PaymentMemo } from "../src/payment.js";

const G = Keypair.random().publicKey();
const REGISTRY = DEPLOYMENTS.testnet.registryId;
const LOOKUP = StrKey.encodeContract(Buffer.alloc(32, 41));
const REGISTRAR = StrKey.encodeContract(Buffer.alloc(32, 42));
const RESOLVER = StrKey.encodeContract(Buffer.alloc(32, 43));
const MAX_U64 = 18446744073709551615n;
const native = (memo: unknown = ["None"], address = G) => ({
  name: "alice.nova", registrar: REGISTRAR, resolver: RESOLVER, generation: MAX_U64,
  result: ["NativePayment", { address, memo }],
});
const legacy = (resolver: string | null = RESOLVER, address = G) => ({
  name: "alice.nova", registrar: REGISTRAR, resolver, generation: MAX_U64,
  result: ["LegacyAddress", address],
});
type Call = { id: string; fn: string; args: xdr.ScVal[] };
function client(output: () => unknown = () => native(), overrides: Record<string, unknown> = {}, options: SoranOptions = {}) {
  const s = new Soran({ lookupId: LOOKUP, primaryId: null, ...options });
  const calls: Call[] = [];
  Object.assign(s, { read: async (id: string, fn: string, args: xdr.ScVal[]) => {
    calls.push({ id, fn, args });
    assert.equal(id, LOOKUP, "payment reads must only contact the configured Lookup");
    if (Object.hasOwn(overrides, fn)) {
      const value = overrides[fn];
      if (value instanceof Error) throw value;
      return value;
    }
    if (fn === "registry") return REGISTRY;
    if (fn === "version") return 1;
    if (fn === "resolve") return output();
    throw new Error(`unexpected direct/fallback read: ${fn}`);
  } });
  return { s, calls };
}
const code = (want: string) => (e: unknown) => e instanceof SoranError && e.code === want;

test("custom Registry never inherits a Lookup ID; null explicitly selects direct mode", async () => {

  for (const lookupId of [undefined, null]) {
    const s = new Soran({ lookupId, registryId: RESOLVER });
    let called = false;
    Object.assign(s, { read: async () => { called = true; throw new Error("must not read"); } });
    await assert.rejects(s.lookup("alice.nova"), code("CONFIG"));
    assert.equal(called, false);
  }
});
test("lookupId rejects malformed, account and nonstring values at construction", () => {
  for (const lookupId of ["", "C…", G, " " + LOOKUP, 1, false, {}, []])
    assert.throws(() => new Soran({ lookupId } as SoranOptions), code("CONFIG"));
  assert.doesNotThrow(() => new Soran({ lookupId: LOOKUP }));
});
test("lookupId null preserves the complete direct native Resolver route", async () => {
  const s = new Soran({ lookupId: null });
  const nsNode = await s.namehash("nova");
  const calls: string[] = [];
  Object.assign(s, { read: async (id: string, fn: string) => {
    calls.push(fn);
    if (fn === "resolver_of") { assert.equal(id, REGISTRY); return RESOLVER; }
    if (fn === "registrar_of") { assert.equal(id, REGISTRY); return REGISTRAR; }
    if (fn === "anchors") { assert.equal(id, REGISTRAR); return [REGISTRY, nsNode]; }
    assert.equal(id, RESOLVER);
    if (fn === "registry") return REGISTRY;
    if (fn === "authority") return REGISTRAR;
    if (fn === "payment_version") return 1;
    assert.equal(fn, "resolve_payment");
    return native().result[1];
  } });
  assert.deepEqual(await s.resolvePayment("alice.nova"), { address: G, memo: { type: "none" } });
  assert.deepEqual(calls, ["resolver_of", "registrar_of", "registry", "authority", "payment_version", "anchors", "resolve_payment"]);
});
test("lookup normalizes input, validates anchor/version each time, preserves exact generation and originating Resolver", async () => {
  const { s, calls } = client();
  const got: LookupResult = await s.lookup("ALICE.NOVA");
  assert.deepEqual(got, { kind: "nativePayment", name: "alice.nova", registrar: REGISTRAR,
    resolver: RESOLVER, generation: MAX_U64, payment: { address: G, memo: { type: "none" } } });
  if (got.kind === "nativePayment") assert.equal(got.payment.memo.type, "none");
  await s.lookup("alice.nova");
  assert.deepEqual(calls.map(({ fn }) => fn), ["registry", "version", "resolve", "registry", "version", "resolve"]);
  for (const c of calls.filter(({ fn }) => fn === "resolve")) assert.equal(scValToNative(c.args[0]), "alice.nova");
});
test("invalid names stop before any chain reads", async () => {
  for (const name of ["alice", "a.b.c", "-a.nova", "a-.nova", "a..nova", " alice.nova", "é.nova", "a".repeat(64) + ".nova"]) {
    const { s, calls } = client();
    await assert.rejects(s.lookup(name), code("INVALID_INPUT"));
    assert.equal(calls.length, 0);
  }
  for (const value of [null, undefined, 1, {}, ["alice.nova"]]) {
    const { s, calls } = client();
    await assert.rejects(s.lookup(value as string), code("INVALID_INPUT"));
    assert.equal(calls.length, 0);
  }
});
test("wrong or malformed Registry anchor and version prevent resolve without fallback", async () => {
  for (const anchor of [null, G, RESOLVER, [REGISTRY], 1]) {
    const { s, calls } = client(undefined, { registry: anchor });
    await assert.rejects(s.lookup("alice.nova"), code("CONFIG"));
    assert.ok(calls.every(({ fn }) => fn !== "resolve"));
  }
  for (const version of [null, 0, 2, 1n, "1", true, [1]]) {
    const { s, calls } = client(undefined, { version });
    await assert.rejects(s.lookup("alice.nova"), code("ABI"));
    assert.ok(calls.every(({ fn }) => fn !== "resolve"));
  }
});
test("custom Registry configuration must match Lookup's Registry", async () => {
  const { s } = client(undefined, { registry: RESOLVER }, { registryId: RESOLVER });
  assert.equal((await s.lookup("alice.nova")).kind, "nativePayment");
  const invalid = client(undefined, { registry: "invalid" }, { registryId: "invalid" });
  await assert.rejects(invalid.s.lookup("alice.nova"), code("CONFIG"));
});

const memos: PaymentMemo[] = [
  { type: "none" }, { type: "id", value: "0" }, { type: "id", value: "9007199254740993" },
  { type: "id", value: MAX_U64.toString() }, { type: "text", value: "😀".repeat(7) },
  { type: "text", value: "\ufeffa|b " }, { type: "hash", value: "ab".repeat(32) },
];
for (const memo of memos) test(`universal native ${memo.type} preserves all payment data`, async () => {
  const { s } = client(() => native(scValToNative(paymentMemoToScVal(memo))));
  const payment = { address: G, memo };
  assert.deepEqual(await s.resolvePayment("alice.nova"), payment);
  assert.equal(await s.verifyPayment("alice.nova", payment), true);
  assert.equal(await s.verifyPayment("alice.nova", { address: RESOLVER, memo: { type: "none" } }), false);
  if (memo.type === "none") {
    assert.equal(await s.resolve("alice.nova"), G);
    assert.equal((await s.record("alice.nova")).resolver, RESOLVER);
    assert.equal(await s.verify("alice.nova", G), true);
  } else {
    for (const run of [() => s.resolve("alice.nova"), () => s.record("alice.nova"), () => s.verify("alice.nova", G)])
      await assert.rejects(run(), code("PAYMENT_REQUIRED"));
  }
});
test("memo-only changes invalidate universal verifyPayment and configured read failure cannot erase a memo", async () => {
  let state: unknown = native(["Id", 1n]);
  const { s } = client(() => { if (state instanceof Error) throw state; return state; });
  const expected = await s.resolvePayment("alice.nova");
  state = native(["Id", 2n]);
  assert.equal(await s.verifyPayment("alice.nova", expected), false);
  state = new SoranError("Error(Contract, #11)", "SIMULATION");
  await assert.rejects(s.resolvePayment("alice.nova"), (e) => e === state);
});
test("universal explicit native None supports C destinations", async () => {
  const { s } = client(() => native(["None"], RESOLVER));
  assert.equal(await s.resolve("alice.nova"), RESOLVER);
});
test("legacy addresses retain unknown memo capability with or without a Resolver; every strict payment method rejects", async () => {
  for (const resolver of [null, RESOLVER]) for (const address of [G, RESOLVER]) {
    const { s } = client(() => legacy(resolver, address));
    const result: LookupResult = await s.lookup("alice.nova");
    assert.deepEqual(result, { kind: "legacyAddress", name: "alice.nova", registrar: REGISTRAR,
      resolver, generation: MAX_U64, address, memoCapability: "unknown" });
    if (result.kind === "legacyAddress") {
      assert.equal(result.memoCapability, "unknown");
      assert.equal(Object.hasOwn(result, "payment"), false);
      assert.equal(Object.hasOwn(result, "memo"), false);
    }
    for (const run of [() => s.resolvePayment("alice.nova"), () => s.resolve("alice.nova"), () => s.record("alice.nova"),
      () => s.verify("alice.nova", address), () => s.verifyPayment("alice.nova", { address, memo: { type: "none" } })])
      await assert.rejects(run(), code("LEGACY_MEMO_UNKNOWN"));
  }
});
test("details/identity carry native memo data and reject legacy without payment fallback", async () => {
  let raw = native(["Text", "memo"]);
  const { s } = client(() => raw);
  Object.assign(s, {
    nameMetadata: async () => ({ name: "alice.nova", node: "00".repeat(32), registrar: REGISTRAR, holder: G, builtinAddress: G, generation: MAX_U64, expiresAt: 0n, active: true, noExpiry: true, namespacePermanent: false }),
    namespaceMetadata: async () => ({ namespace: "nova", node: "00".repeat(32), owner: G, registrar: REGISTRAR, resolver: RESOLVER, resolverAttested: false, resolverLocked: false, resolverTainted: false, registrarTainted: false, permanent: false, policy: null }),
    attestedRegistrarOf: async () => null, namespace: async () => null,
    assurance: async () => ({ trustworthy: false, resolverAttested: false, resolverTainted: false, resolverLocked: false }),
    profile: async () => ({}) });
  const details = await s.details("alice.nova");
  assert.deepEqual(details.payment, { address: G, memo: { type: "text", value: "memo" } });
  assert.equal(details.paymentRequired, true);
  assert.equal(details.resolver, RESOLVER);
  assert.deepEqual((await s.identity("alice.nova")).details.payment, details.payment);
  raw = legacy() as typeof raw;
  await assert.rejects(s.details("alice.nova"), code("LEGACY_MEMO_UNKNOWN"));
  await assert.rejects(s.identity("alice.nova"), code("LEGACY_MEMO_UNKNOWN"));
});

const malformed: Array<[string, unknown]> = [
  ["null", null], ["array", []], ["extra field", { ...native(), extra: true }],
  ["missing result", { name: "alice.nova", registrar: REGISTRAR, resolver: RESOLVER, generation: 1n }],
  ["different name", { ...native(), name: "bob.nova" }], ["noncanonical name", { ...native(), name: "ALICE.NOVA" }],
  ["account Registrar", { ...native(), registrar: G }], ["missing Registrar", { ...native(), registrar: null }],
  ["account Resolver", { ...native(), resolver: G }], ["missing Resolver option", { ...native(), resolver: undefined }],
  ["native without Resolver", { ...native(), resolver: null }],
  ...[0, Number.MAX_SAFE_INTEGER + 1, "1", -1n, MAX_U64 + 1n, null].map((generation): [string, unknown] => ["generation " + String(generation), { ...native(), generation }]),
  ...[[], ["NativePayment"], ["NativePayment", native().result[1], true], ["Unknown", G], { NativePayment: native().result[1] }, ["LegacyAddress", null], ["LegacyAddress", "invalid"]]
    .map((result, i): [string, unknown] => ["enum " + i, { ...native(), result }]),
  ...[["None", "extra"], ["Id", 1], ["Id", "1"], ["Id", -1n], ["Id", MAX_U64 + 1n], ["Text", ""],
    ["Text", "😀".repeat(8)], ["Text", "\ud800"], ["Hash", new Uint8Array(31)], ["Hash", "ab".repeat(32)], ["Other"]]
    .map((memo, i): [string, unknown] => ["memo " + i, native(memo)]),
  ["payment extra field", { ...native(), result: ["NativePayment", { address: G, memo: ["None"], extra: true }] }],
  ["invalid payment address", native(["None"], "invalid")],
  ["C with required memo", native(["Id", 1n], RESOLVER)],
];
for (const [label, raw] of malformed) test(`reject malformed universal response: ${label}`, async () => {
  const { s } = client(() => raw);
  await assert.rejects(s.lookup("alice.nova"), code("ABI"));
  await assert.rejects(s.resolvePayment("alice.nova"), code("ABI"));
});
test("every transport, restore, simulation and timeout error propagates without direct fallback", async () => {
  for (const fn of ["registry", "version", "resolve"]) for (const failureCode of ["RPC", "ARCHIVED", "SIMULATION", "TIMEOUT", "ABI"] as const) {
    const failure = new SoranError(`failure at ${fn}`, failureCode);
    const { s, calls } = client(undefined, { [fn]: failure });
    for (const run of [() => s.lookup("alice.nova"), () => s.resolvePayment("alice.nova"), () => s.resolve("alice.nova"),
      () => s.record("alice.nova"), () => s.verify("alice.nova", G), () => s.verifyPayment("alice.nova", { address: G, memo: { type: "none" } })])
      await assert.rejects(run(), (e) => e === failure);
    assert.ok(calls.every(({ id, fn }) => id === LOOKUP && ["registry", "version", "resolve"].includes(fn)));
    if (fn !== "resolve") assert.equal(calls.some(({ fn }) => fn === "resolve"), false);
  }
});
test("anchor and version changes after a successful read are detected before another resolution", async () => {
  for (const change of ["registry", "version"]) {
    const overrides: Record<string, unknown> = {};
    const { s, calls } = client(undefined, overrides);
    await s.resolvePayment("alice.nova");
    overrides[change] = change === "registry" ? RESOLVER : 2;
    await assert.rejects(s.resolvePayment("alice.nova"), code(change === "registry" ? "CONFIG" : "ABI"));
    assert.equal(calls.filter(({ fn }) => fn === "resolve").length, 1);
  }
});

function mapScVal(fields: Record<string, xdr.ScVal>): xdr.ScVal {
  return xdr.ScVal.scvMap(Object.keys(fields).sort().map((key) => new xdr.ScMapEntry({
    key: nativeToScVal(key, { type: "symbol" }), val: fields[key],
  })));
}
test("actual RPC decoder handles Lookup struct, enum, optional address and exact u64 XDR", async () => {
  for (const isLegacy of [false, true]) {
    const s = new Soran({ lookupId: LOOKUP });
    const seen: string[] = [];
    const response = mapScVal({
      name: nativeToScVal("alice.nova", { type: "string" }),
      registrar: nativeToScVal(REGISTRAR, { type: "address" }),
      resolver: isLegacy ? xdr.ScVal.scvVoid() : nativeToScVal(RESOLVER, { type: "address" }),
      generation: nativeToScVal(MAX_U64, { type: "u64" }),
      result: xdr.ScVal.scvVec([nativeToScVal(isLegacy ? "LegacyAddress" : "NativePayment", { type: "symbol" }),
        isLegacy ? nativeToScVal(G, { type: "address" }) : mapScVal({
          address: nativeToScVal(G, { type: "address" }), memo: paymentMemoToScVal({ type: "id", value: MAX_U64.toString() }),
        })]),
    });
    Object.assign(s, { server: { simulateTransaction: async (tx: { operations: Array<{ func: { invokeContract: {
      contractAddress: { contractId: { value: Uint8Array } }; functionName: { toString(): string };
    } } }> }) => {
      const invoke = tx.operations[0].func.invokeContract;
      assert.equal(StrKey.encodeContract(invoke.contractAddress.contractId.value), LOOKUP);
      const fn = invoke.functionName.toString();
      seen.push(fn);
      const retval = fn === "registry" ? nativeToScVal(REGISTRY, { type: "address" })
        : fn === "version" ? nativeToScVal(1, { type: "u32" }) : response;
      return { transactionData: {}, result: { retval } };
    } } });
    const result = await s.lookup("alice.nova");
    assert.equal(result.generation, MAX_U64);
    assert.equal(result.kind, isLegacy ? "legacyAddress" : "nativePayment");
    if (result.kind === "nativePayment") assert.deepEqual(result.payment.memo, { type: "id", value: MAX_U64.toString() });
    else assert.equal(result.resolver, null);
    assert.deepEqual(seen, ["registry", "version", "resolve"]);
  }
});
test("Lookup contract errors remain typed simulation errors and never become null/None", async () => {
  for (let contractCode = 1; contractCode <= 18; contractCode++) {
    const s = new Soran({ lookupId: LOOKUP });
    let calls = 0;
    Object.assign(s, { server: { simulateTransaction: async () => {
      calls++;
      return { error: `HostError: Error(Contract, #${contractCode})` };
    } } });
    await assert.rejects(s.resolvePayment("alice.nova"), (e: unknown) =>
      e instanceof SoranError && e.code === "SIMULATION" && e.message.includes(`#${contractCode}`));
    assert.equal(calls, 2);
  }
});
