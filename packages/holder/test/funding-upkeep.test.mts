import test from "node:test";
import assert from "node:assert/strict";
import {
  Networks,
  SorobanDataBuilder,
  StrKey,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import { FundingReader } from "../src/funding-reader.js";
import { namespaceNode, hex } from "../src/native-codec.js";
import {
  fundingPositionId,
  upkeepPositionId,
  upkeepPolicyToScVal,
  storagePlanToScVal,
  upkeepReceiptFromNative,
  upkeepReceiptToScVal,
  type UpkeepPolicy,
} from "../src/funding-types.js";
const C = (n: number) => StrKey.encodeContract(new Uint8Array(32).fill(n));
const G = StrKey.encodeEd25519PublicKey(new Uint8Array(32).fill(1));
const policy: UpkeepPolicy = {
  relayer: G,
  renewalCap: 100n,
  dailyCap: 200n,
  totalCap: 300n,
  retention: 518400,
  renewBefore: 120960,
  quoteLifetime: 60,
  validUntil: 9000000000n,
};
test("upkeep money and owner epochs use a separate deterministic ID domain", () => {
  const ns = hex(namespaceNode("nova"));
  assert.notEqual(upkeepPositionId(ns, 1n), fundingPositionId(ns, 1n));
  assert.notEqual(upkeepPositionId(ns, 1n), upkeepPositionId(ns, 2n));
  assert.equal(upkeepPositionId(ns, 1n), upkeepPositionId(ns, 1n));
});
test("all caps, retention, quote deadlines and relayer addresses are validated before signing", () => {
  assert.doesNotThrow(() => upkeepPolicyToScVal(policy));
  for (const p of [
    { ...policy, renewalCap: 0n },
    { ...policy, dailyCap: 99n },
    { ...policy, totalCap: 199n },
    { ...policy, renewBefore: 518400 },
    { ...policy, renewBefore: 0 },
    { ...policy, quoteLifetime: 121 },
    { ...policy, relayer: C(3) },
    { ...policy, totalCap: 1 as any },
  ])
    assert.throws(() => upkeepPolicyToScVal(p));
});
test("only bounded canonical, unique namespace keys fit the storage plan", () => {
  const p = {
    registrar: C(2),
    resolver: C(3),
    registrarKeys: [xdr.ScVal.scvU32(1)],
    resolverKeys: [],
  };
  assert.doesNotThrow(() => storagePlanToScVal(p));
  assert.throws(
    () =>
      storagePlanToScVal({
        ...p,
        registrarKeys: [...p.registrarKeys, ...p.registrarKeys],
      }),
    /Duplicate/,
  );
  assert.throws(
    () =>
      storagePlanToScVal({
        ...p,
        registrarKeys: Array.from({ length: 33 }, (_, i) =>
          xdr.ScVal.scvU32(i),
        ),
      }),
    /32/,
  );
  assert.throws(
    () =>
      storagePlanToScVal({
        ...p,
        registrarKeys: [xdr.ScVal.scvBytes(new Uint8Array(17000))],
      }),
    /size/,
  );
  assert.throws(
    () => storagePlanToScVal({ ...p, resolver: p.registrar }),
    /routes/,
  );
});
test("receipts round-trip exactly without lossy JSON money conversion", () => {
  const r = {
    quoteHash: "01".repeat(32),
    quoteId: "02".repeat(32),
    nonce: 123n,
    charge: 99000000n,
    balance: 30000000n,
    ledger: 100,
    coveredUntil: 518500,
  };
  assert.deepEqual(
    upkeepReceiptFromNative(scValToNative(upkeepReceiptToScVal(r))),
    r,
  );
  assert.throws(() => upkeepReceiptToScVal({ ...r, charge: 99000000 as any }));
});
test("protocol 29 restored simulations never masquerade as live budget reads", async () => {
  const raw = new SorobanDataBuilder().build();
  const archived = new xdr.SorobanTransactionData({
    ...raw,
    ext: xdr.SorobanTransactionDataExt.resourceExt(
      new xdr.SorobanResourcesExtV0({ archivedSorobanEntries: [0] }),
    ),
  });
  const reader = new FundingReader({
    fundingId: C(1),
    registryId: C(2),
    lookupId: C(3),
    primaryId: C(4),
    networkPassphrase: Networks.TESTNET,
    server: {
      simulateTransaction: async () => ({
        _parsed: true,
        transactionData: new SorobanDataBuilder(archived),
        latestLedger: 100,
        minResourceFee: "0",
        events: [],
        result: { auth: [], retval: xdr.ScVal.scvU32(1) },
      }),
    } as never,
  });
  await assert.rejects(reader.read(C(1), "upkeep_version", []), /archived/);
});
