import assert from "node:assert/strict";
import test from "node:test";
import { Keypair, StrKey, scValToNative } from "@stellar/stellar-sdk";
import { Soran, SoranError, DEPLOYMENTS } from "../src/index.js";
import { encodePaymentRecord, parsePaymentRecord, paymentFromNative, paymentMemoToScVal, validatePaymentDestination, type PaymentMemo } from "../src/payment.js";

const G = Keypair.random().publicKey();
const C = StrKey.encodeContract(Buffer.alloc(32, 1));
const OTHER = Keypair.random().publicKey();
const REGISTRY = DEPLOYMENTS.testnet.registryId;
const memos: PaymentMemo[] = [
  { type: "none" }, { type: "id", value: "0" }, { type: "id", value: "9007199254740993" },
  { type: "id", value: "18446744073709551615" }, { type: "text", value: "a|b " }, { type: "text", value: "\ufeffstart" },
  { type: "text", value: "😀".repeat(7) }, { type: "hash", value: "ab".repeat(32) },
];
for (const memo of memos) test(`round-trip wire and real XDR ${memo.type} ${"value" in memo ? memo.value : ""}`, () => {
  const p = { address: G, memo };
  const wire = encodePaymentRecord(p);
  assert.ok(new TextEncoder().encode(wire).length <= 128);
  assert.deepEqual(parsePaymentRecord(wire), p);
  assert.deepEqual(paymentFromNative({ address: G, memo: scValToNative(paymentMemoToScVal(memo)) }), p);
});
test("hash record uses full 128-byte bound", () => assert.equal(encodePaymentRecord({ address: G, memo: { type: "hash", value: "00".repeat(32) } }).length, 128));
test("C destination only permits explicit None", () => {
  assert.deepEqual(parsePaymentRecord(`1|${C}|none|`), { address: C, memo: { type: "none" } });
  assert.throws(() => parsePaymentRecord(`1|${C}|id|1`));
});
for (const raw of ["", `2|${G}|none|`, `1|${G}|none|x`, `1|${G}|id|01`, `1|${G}|id|-1`, `1|${G}|id|18446744073709551616`, `1|${G}|text|`, `1|${G}|text|${"😀".repeat(8)}`, `1|${G}|hash|${"AA".repeat(32)}`, `1|${G}|hash|${"ab".repeat(31)}`, `1|${G}|return|${"ab".repeat(32)}`, `1|bad|none|`, `1|${G}|text|\ud800`]) {
  test(`reject malformed wire ${JSON.stringify(raw).slice(0, 95)}`, () => assert.throws(() => parsePaymentRecord(raw)));
}
test("rejects numeric ID, extra fields, invalid native variants", () => {
  assert.throws(() => validatePaymentDestination({ address: G, memo: { type: "id", value: 1 } }));
  assert.throws(() => validatePaymentDestination({ address: G, memo: { type: "none", value: "" } }));
  assert.throws(() => validatePaymentDestination({ address: G, memo: { type: "none" }, ignored: true }));
  for (const memo of [["Id", 1], ["Id", -1n], ["None", "extra"], ["Unknown"], ["Hash", new Uint8Array(31)]])
    assert.throws(() => paymentFromNative({ address: G, memo }));
});

type FakeRead = (id: string, fn: string, args: unknown[]) => Promise<unknown>;
const nsNode = await new Soran({ resolutionMode: "direct" }).namehash("nova");
const REGISTRAR = StrKey.encodeContract(Buffer.alloc(32, 2));
const NEXT = StrKey.encodeContract(Buffer.alloc(32, 3));
const raw = (memo: PaymentMemo) => ({ address: G, memo: scValToNative(paymentMemoToScVal(memo)) });
function client(payment: () => unknown, overrides: Record<string, unknown> = {}) {
  const calls: Array<{ id: string; fn: string; args: unknown[] }> = [];
  const s = new Soran({ resolutionMode: "direct" });
  const read: FakeRead = async (id, fn, args) => {
    calls.push({ id, fn, args });
    if (Object.hasOwn(overrides, fn)) {
      const v = overrides[fn];
      if (v instanceof Error) throw v;
      return v;
    }
    if (fn === "resolver_of") { assert.equal(id, REGISTRY); return C; }
    if (fn === "registrar_of") { assert.equal(id, REGISTRY); return REGISTRAR; }
    if (fn === "anchors") { assert.equal(id, REGISTRAR); return [REGISTRY, nsNode]; }
    assert.equal(id, C);
    if (fn === "registry") return REGISTRY;
    if (fn === "authority") return REGISTRAR;
    if (fn === "payment_version") return 1;
    if (fn === "resolve_payment") return payment();
    throw new Error(`unexpected fallback ${fn}`);
  };
  Object.assign(s, { read });
  return { s, calls };
}
test("native payment discovers current Resolver and checks its Registry, Registrar and version", async () => {
  const { s, calls } = client(() => raw({ type: "id", value: "18446744073709551615" }));
  assert.equal((await s.resolvePayment("ALICE.NOVA")).memo.type, "id");
  await s.resolvePayment("alice.nova");
  assert.deepEqual(calls.map((c) => c.fn), Array(2).fill(["resolver_of", "registrar_of", "registry", "authority", "payment_version", "anchors", "resolve_payment"]).flat());
  for (const c of calls.filter((c) => c.fn === "resolve_payment")) assert.equal(scValToNative(c.args[0] as never), "alice.nova");
});
test("absent/invalid pointers, wrong anchors and unsupported version stop before resolution", async () => {
  for (const overrides of [{ resolver_of: null }, { resolver_of: G }, { registrar_of: null }, { registry: C }, { authority: C }, { anchors: [C, nsNode] }, { anchors: [REGISTRY, new Uint8Array(32)] }, { payment_version: 0 }, { payment_version: 2 }, { payment_version: 1n }]) {
    const { s, calls } = client(() => { throw new Error("must not resolve"); }, overrides);
    await assert.rejects(s.resolvePayment("alice.nova"));
    assert.equal(calls.some((c) => c.fn === "resolve_payment"), false);
  }
});
test("native discovery follows a replaced pointer without using resolver caches", async () => {
  let resolver = C;
  const s = new Soran({ resolutionMode: "direct", resolverCacheTtlMs: 60_000 });
  Object.assign(s, { read: async (id: string, fn: string) => {
    if (fn === "resolver_of") return resolver;
    if (fn === "registrar_of") return REGISTRAR;
    if (fn === "anchors") { assert.equal(id, REGISTRAR); return [REGISTRY, nsNode]; }
    assert.equal(id, resolver);
    if (fn === "registry") return REGISTRY;
    if (fn === "authority") return REGISTRAR;
    if (fn === "payment_version") return 1;
    assert.equal(fn, "resolve_payment");
    return { address: resolver === C ? G : OTHER, memo: ["None"] };
  } });
  assert.equal((await s.record("alice.nova")).resolver, C);
  resolver = NEXT;
  assert.equal((await s.record("alice.nova")).resolver, NEXT);
  assert.equal(await s.resolve("alice.nova"), OTHER);
});
test("old unsupported ABI and RPC failures never invoke legacy addr/text/Registrar resolution", async () => {
  for (const fn of ["resolver_of", "registrar_of", "registry", "authority", "payment_version", "anchors", "resolve_payment"]) {
    const failure = new SoranError(`unavailable ${fn}`, "SIMULATION");
    const { s, calls } = client(() => raw({ type: "none" }), { [fn]: failure });
    for (const run of [() => s.resolvePayment("alice.nova"), () => s.resolve("alice.nova"), () => s.record("alice.nova"), () => s.verify("alice.nova", G)])
      await assert.rejects(run(), (e) => e === failure);
    assert.ok(calls.every((c) => !["addr", "text", "resolve"].includes(c.fn)));
  }
});
test("memo-only changes invalidate verifyPayment", async () => {
  const { s } = client(() => raw({ type: "id", value: "2" }));
  assert.equal(await s.verifyPayment("alice.nova", { address: G, memo: { type: "id", value: "1" } }), false);
  assert.equal(await s.verifyPayment("alice.nova", { address: G, memo: { type: "id", value: "2" } }), true);
  assert.equal(await s.verifyPayment("alice.nova", { address: OTHER, memo: { type: "id", value: "2" } }), false);
});
test("malformed native response cannot downgrade", async () => {
  for (const output of [null, { address: G, memo: ["Id", 1] }, { address: G, memo: ["None"], extra: true }]) {
    const { s } = client(() => output);
    await assert.rejects(s.resolvePayment("alice.nova"), (e: unknown) => e instanceof SoranError && e.code === "ABI");
    await assert.rejects(s.resolve("alice.nova"));
  }
});
test("address-only lookup accepts only native None", async () => {
  let memo: PaymentMemo = { type: "none" };
  const { s } = client(() => raw(memo));
  assert.equal(await s.resolve("alice.nova"), G);
  memo = { type: "text", value: "required" };
  for (const run of [() => s.resolve("alice.nova"), () => s.record("alice.nova"), () => s.verify("alice.nova", G)])
    await assert.rejects(run(), (e: unknown) => e instanceof SoranError && e.code === "PAYMENT_REQUIRED");
});
test("details and identity retain a valid complete memo-bearing payment", async () => {
  const { s } = client(() => raw({ type: "id", value: "17" }));
  Object.assign(s, {
    attestedRegistrarOf: async () => null,
    namespace: async () => null,
    assurance: async () => ({ trustworthy: false, resolverAttested: true, resolverTainted: false, resolverLocked: false }),
    profile: async () => ({}),
  });
  const d = await s.details("alice.nova");
  assert.equal(d.address, G); assert.equal(d.resolver, C);
  assert.deepEqual(d.payment, { address: G, memo: { type: "id", value: "17" } });
  assert.equal(d.paymentRequired, true);
  assert.deepEqual((await s.identity("alice.nova")).details.payment, d.payment);
});
test("ordinary G and C names need no setup when the native Resolver returns None", async () => {
  for (const address of [G, C]) {
    const { s } = client(() => ({ address, memo: ["None"] }));
    assert.deepEqual(await s.resolvePayment("ordinary.nova"), { address, memo: { type: "none" } });
    assert.equal(await s.resolve("ordinary.nova"), address);
    assert.equal(await s.verifyPayment("ordinary.nova", { address, memo: { type: "none" } }), true);
  }
});
test("memo activation and configured-record loss never become ordinary defaults", async () => {
  let state: "ordinary" | "memo" | "missing" | "new-generation" = "ordinary";
  const failure = new SoranError("configured payment record missing", "SIMULATION");
  const { s } = client(() => {
    if (state === "missing") throw failure;
    return raw(state === "memo" ? { type: "id", value: "42" } : { type: "none" });
  });
  const ordinary = await s.resolvePayment("alice.nova");
  state = "memo";
  assert.equal(await s.verifyPayment("alice.nova", ordinary), false);
  await assert.rejects(s.resolve("alice.nova"), (e: unknown) => e instanceof SoranError && e.code === "PAYMENT_REQUIRED");
  const required = await s.resolvePayment("alice.nova");
  state = "missing";
  for (const run of [() => s.resolvePayment("alice.nova"), () => s.resolve("alice.nova"), () => s.verifyPayment("alice.nova", required)])
    await assert.rejects(run(), (e) => e === failure);
  state = "new-generation";
  assert.equal(await s.verifyPayment("alice.nova", required), false);
  assert.deepEqual(await s.resolvePayment("alice.nova"), ordinary);
});
