import assert from "node:assert/strict";
import test from "node:test";
import { Account, Keypair, Networks, SorobanDataBuilder, StrKey, TransactionBuilder, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { SoranHolder, HolderError } from "../src/index.js";

const key = Keypair.random(), account = key.publicKey();
const contract = StrKey.encodeContract(new Uint8Array(32).fill(9));
function fixture(options: { resourceFee?: string; restoreFee?: string; maxNetworkFeeStroops?: bigint; maxNativeFeeStroops?: bigint; sendError?: string; confirmError?: string; alterSignedFee?: boolean } = {}) {
  let simulations = 0, sends = 0;
  const signedFees: string[] = [], sentHashes: string[] = [];
  const client = new SoranHolder({ maxNetworkFeeStroops: options.maxNetworkFeeStroops, maxNativeFeeStroops: options.maxNativeFeeStroops,
    signer: { publicKey: () => account, signTransaction: async (raw, { networkPassphrase }) => {
      let tx = TransactionBuilder.fromXDR(raw, networkPassphrase);
      signedFees.push(tx.fee);
      if (options.alterSignedFee) tx = TransactionBuilder.cloneFrom(tx as any, { networkPassphrase, fee: "500000001" }).build();
      tx.sign(key); return tx.toXDR();
    } },
  });
  Object.assign(client, { registrarOf: async () => contract, resolverOf: async () => contract, server: {
    getAccount: async () => new Account(account, String(sends)),
    simulateTransaction: async () => {
      const result = { _parsed: true, transactionData: new SorobanDataBuilder().setResourceFee(options.resourceFee ?? "0"), minResourceFee: options.resourceFee ?? "0", result: { auth: [], retval: nativeToScVal(2000n, { type: "u64" }) }, events: [], latestLedger: 100 };
      if (++simulations === 1 && options.restoreFee !== undefined) return { ...result, restorePreamble: { minResourceFee: options.restoreFee, transactionData: new SorobanDataBuilder().setResourceFee(options.restoreFee) } };
      return result;
    },
    sendTransaction: async (tx: any) => {
      sends++; const hash = Buffer.from(tx.hash()).toString("hex"); sentHashes.push(hash);
      if (options.sendError) throw new Error(options.sendError);
      return { status: "PENDING", hash };
    },
    getTransaction: async () => {
      if (options.confirmError) throw new Error(options.confirmError);
      return { status: "SUCCESS", ledger: 101, returnValue: nativeToScVal(2000n, { type: "u64" }) };
    },
  } });
  return { client, run: () => client.setText("audit.nova", "url", "https://example.org"), stats: () => ({ simulations, sends, signedFees, sentHashes }) };
}

test("legacy operations reject an excessive estimate before signing", async () => {
  const f = fixture({ resourceFee: "500000000" });
  await assert.rejects(f.run(), /network fee .* exceeds the configured maximum 50000000/);
  assert.equal(f.stats().signedFees.length, 0); assert.equal(f.stats().sends, 0);
});
test("the total limit includes the base fee and allows its exact boundary", async () => {
  const accepted = fixture({ resourceFee: "49999900" }); await accepted.run();
  assert.deepEqual(accepted.stats().signedFees, ["50000000"]);
  const refused = fixture({ resourceFee: "49999901" }); await assert.rejects(refused.run(), /exceeds/);
  assert.equal(refused.stats().signedFees.length, 0);
});
test("reviewed overrides apply to legacy writes and explicit total ceiling takes precedence", async () => {
  for (const opts of [{ maxNetworkFeeStroops: 600000000n }, { maxNativeFeeStroops: 600000000n }]) {
    const f = fixture({ ...opts, resourceFee: "500000000" }); await f.run(); assert.equal(f.stats().sends, 1);
  }
  const f = fixture({ maxNetworkFeeStroops: 1000n, maxNativeFeeStroops: 600000000n, resourceFee: "1000" });
  await assert.rejects(f.run(), /maximum 1000/); assert.equal(f.stats().signedFees.length, 0);
});
test("all configured fee caps reject invalid or unbounded values", () => {
  for (const option of ["maxNetworkFeeStroops", "maxNativeFeeStroops"]) for (const value of [0n, -1n, 4294967296n, 10, "10"]) {
    assert.throws(() => new SoranHolder({ signer: { publicKey: () => account, signTransaction: async s => s }, [option]: value } as any), /maximum network fee/);
  }
});
test("automatic restoration is capped before approval and its approved override works", async () => {
  const blocked = fixture({ restoreFee: "500000000" }); await assert.rejects(blocked.run(), /restore_footprint.*exceeds/);
  assert.equal(blocked.stats().signedFees.length, 0); assert.equal(blocked.stats().sends, 0);
  const allowed = fixture({ restoreFee: "500000000", maxNetworkFeeStroops: 600000000n }); await allowed.run();
  assert.deepEqual(allowed.stats().signedFees, ["500000100", "100"]); assert.equal(allowed.stats().sends, 2);
});
test("a signing callback cannot replace a transaction with a higher-fee body", async () => {
  const f = fixture({ alterSignedFee: true }); await assert.rejects(f.run(), /signer changed/);
  assert.equal(f.stats().sends, 0);
});
for (const phase of ["sendError", "confirmError"] as const) for (const restoration of [false, true]) test(`${restoration ? "restoration" : "ordinary"} ${phase} preserves the original hash and never retries misleading bad_seq text`, async () => {
  const f = fixture({ ...(restoration ? { restoreFee: "500" } : {}), [phase]: "transport lost after possible acceptance: tx_bad_seq" });
  await assert.rejects(f.run(), (e: any) => e instanceof HolderError && e.txHash === f.stats().sentHashes[0]);
  assert.equal(f.stats().sends, 1); assert.equal(f.stats().simulations, 1);
});
