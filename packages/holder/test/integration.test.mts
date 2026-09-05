import assert from "node:assert/strict";
import test from "node:test";
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import { SoranHolder, HolderError, normalizeLabel, parseName, DEPLOYMENTS } from "../src/index.js";
const G = Keypair.random().publicKey();
const C = StrKey.encodeContract(Buffer.alloc(32, 1));
const signer = { publicKey: () => G, signTransaction: async () => { throw new Error("must not sign in unit test"); } };
test("holder names reject Unicode before ASCII lowercase", async () => {
  assert.equal(normalizeLabel("NOVA"), "nova");
  assert.deepEqual(parseName("ALICE.NOVA"), { label: "alice", namespace: "nova" });
  for (const value of ["K.nova", "alice.K", "é.nova", "a..nova", " a.nova"]) assert.throws(() => parseName(value), HolderError);
  const holder = new SoranHolder({ signer });
  let reads = 0; Object.assign(holder, { read: async () => { reads++; throw new Error("must not read"); } });
  await assert.rejects(holder.setPayment("K.nova", { address: G, memo: { type: "none" } }), HolderError);
  await assert.rejects(holder.resolverOf("K"), HolderError);
  assert.equal(reads, 0);
});
test("holder Primary writes check the selected Registry before any signing", async () => {
  const holder = new SoranHolder({ signer, primaryId: C });
  let anchor = C, invocations = 0;
  Object.assign(holder, { read: async (_id: string, fn: string) => { assert.equal(fn, "registry"); return anchor; },
    invoke: async (_id: string, fn: string) => { invocations++; assert.ok(["set_primary", "clear_primary"].includes(fn)); return { hash: "hash", ledger: 1 }; } });
  await assert.rejects(holder.setPrimary("alice.nova"), /different Registry/);
  await assert.rejects(holder.clearPrimary(), /different Registry/);
  assert.equal(invocations, 0);
  anchor = DEPLOYMENTS.testnet.registryId;
  await holder.setPrimary("ALICE.NOVA"); await holder.clearPrimary();
  assert.equal(invocations, 2);
});
