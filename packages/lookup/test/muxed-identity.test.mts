import assert from "node:assert/strict";
import test from "node:test";
import { StrKey, scValToNative, xdr } from "@stellar/stellar-sdk";
import { Soran, DEPLOYMENTS, encodeMuxedAddress } from "../src/index.js";

const G = StrKey.encodeEd25519PublicKey(new Uint8Array(32).fill(2));
const LOOKUP = DEPLOYMENTS.testnet.lookupId;
function fixture(overrides: Record<string, unknown> = {}, options: Record<string, unknown> = {}) {
  const s = new Soran({ lookupId: LOOKUP, reverseNamespaces: ["nova"], ...options });
  const calls: Array<{ id: string; fn: string; args: unknown[] }> = [];
  Object.assign(s, { read: async (id: string, fn: string, args: xdr.ScVal[]) => {
    calls.push({ id, fn, args: args.map(scValToNative) });
    const values: Record<string, unknown> = { registry: DEPLOYMENTS.testnet.registryId, version: 2, destination_version: 2, muxed_identity_version: 1,
      reverse_muxed: "alice.nova", primary_name_muxed: "alice.nova", ...overrides };
    assert.ok(Object.hasOwn(values, fn), "unexpected account-level read " + fn);
    const value = values[fn]; if (value instanceof Error) throw value; return value;
  } });
  return { s, calls };
}
for (const id of ["0", "9007199254740993", "18446744073709551615"]) test("M reverse and primary preserve exact routing ID " + id, async () => {
  const M = encodeMuxedAddress(G, id), { s, calls } = fixture();
  assert.equal(await s.reverse("NOVA", M), "alice.nova");
  assert.equal(await s.primaryOf(M), "alice.nova");
  assert.equal(await s.reverseVerify(M, "ALICE.NOVA"), true);
  assert.equal(await s.reverseLookup(M), "alice.nova");
  assert.deepEqual(await s.reverseNames(M), [{ name: "alice.nova", namespace: "nova", primary: true }]);
  for (const call of calls) assert.equal(call.id, LOOKUP);
  for (const call of calls.filter(c => c.fn === "reverse_muxed")) assert.deepEqual(call.args, ["nova", G, BigInt(id)]);
  for (const call of calls.filter(c => c.fn === "primary_name_muxed")) assert.deepEqual(call.args, [G, BigInt(id)]);
});
test("M proof errors and old capability fail closed across convenience methods", async () => {
  const M = encodeMuxedAddress(G, "42");
  for (const overrides of [{ muxed_identity_version: 0 }, { muxed_identity_version: 1n }, { version: 1 },
    { registry: StrKey.encodeContract(new Uint8Array(32)) }, { muxed_identity_version: new Error("offline") },
    { reverse_muxed: new Error("proof unavailable"), primary_name_muxed: new Error("proof unavailable") }]) {
    const { s, calls } = fixture(overrides);
    for (const action of [() => s.reverse("nova", M), () => s.primaryOf(M), () => s.reverseLookup(M, []), () => s.reverseNames(M, [])]) await assert.rejects(action());
    assert.ok(calls.every(c => c.id === LOOKUP));
    assert.ok(!calls.some(c => ["reverse", "name_of", "primary", "primary_name", "primary_of"].includes(c.fn)));
  }
  const direct = new Soran({ resolutionMode: "direct" });
  Object.assign(direct, { read: async () => assert.fail("must reject direct mode before reads") });
  for (const action of [() => direct.reverse("nova", M), () => direct.primaryOf(M), () => direct.reverseLookup(M), () => direct.reverseNames(M)]) await assert.rejects(action(), /Universal Lookup/);
});
test("M remains distinct from account holdings and Primary pointer", async () => {
  const M = encodeMuxedAddress(G, "42");
  const { s, calls } = fixture({ primary_name_muxed: null, reverse_muxed: null }, { hintUrl: "https://example.com", primaryId: StrKey.encodeContract(new Uint8Array(32)) });
  assert.equal(await s.primaryOf(M), null, "M Primary is stored in Lookup, not the G/C Primary contract");
  Object.assign(s, { namesOfPage: async () => assert.fail("M cannot be a holder") });
  const profile = await s.walletProfile(M);
  assert.equal(profile.address, M); assert.equal(profile.holdings, null); assert.equal(profile.names, null);
  assert.ok(!calls.some(c => c.fn === "primary"));
});
test("M reverse output must be canonical and in the requested namespace", async () => {
  const M = encodeMuxedAddress(G, "42");
  for (const name of ["Alice.nova", "alice.other", 123, undefined]) await assert.rejects(fixture({ reverse_muxed: name }).s.reverse("nova", M));
  for (const name of ["Alice.nova", "K.nova", 123, undefined]) await assert.rejects(fixture({ primary_name_muxed: name }).s.primaryOf(M));
  const bad = M.slice(0, -1) + (M.endsWith("A") ? "B" : "A");
  const { s, calls } = fixture();
  await assert.rejects(s.reverse("nova", bad)); assert.equal(await s.primaryOf(bad), null); assert.equal(calls.length, 0);
});

test("disabling G/C Primary never disables independent M elections", async () => {
  const M = encodeMuxedAddress(G, "42"), { s, calls } = fixture({}, { primaryId: null, reverseNamespaces: [] });
  assert.equal(await s.primaryOf(M), "alice.nova"); assert.equal(await s.reverseLookup(M, []), "alice.nova");
  assert.deepEqual(await s.reverseNames(M, []), [{ name: "alice.nova", namespace: "nova", primary: true }]);
  assert.equal(await s.primaryOf(G), null); assert.ok(!calls.some(c => c.fn === "primary"));
});
