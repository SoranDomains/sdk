import assert from "node:assert/strict";
import test from "node:test";
import { Keypair, StrKey, scValToNative } from "@stellar/stellar-sdk";
import { SoranOwner, OwnerError, normalizeLabel } from "../src/index.js";
const G = Keypair.random().publicKey(), C = StrKey.encodeContract(Buffer.alloc(32, 1));
test("owner labels use ASCII case normalization and reject Unicode aliases before discovery", async () => {
  assert.equal(normalizeLabel("ALICE"), "alice");
  for (const value of ["K", "Ａ", "é", "-a", "a-", "", "a".repeat(64)]) assert.throws(() => normalizeLabel(value), OwnerError);
  const owner = new SoranOwner({ signer: { publicKey: () => G, signTransaction: async () => { throw new Error("must not sign"); } } });
  let reads = 0;
  Object.assign(owner, { read: async () => { reads++; return C; }, invoke: async (_id: string, fn: string, args: unknown[]) => {
    assert.equal(fn, "issue"); assert.equal(Buffer.from(scValToNative(args[0] as never)).toString(), "alice");
    return { hash: "hash", ledger: 1, returnValue: new Uint8Array(32) };
  } });
  await assert.rejects(owner.issue("nova", "K", G), OwnerError); assert.equal(reads, 0);
  await assert.rejects(owner.namespaceOwner("K"), OwnerError); assert.equal(reads, 0);
  await owner.issue("NOVA", "ALICE", G); assert.equal(reads, 1);
});
