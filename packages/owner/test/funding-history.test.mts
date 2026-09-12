import assert from "node:assert/strict";
import test from "node:test";
import {
  Account,
  Contract,
  Keypair,
  Networks,
  StrKey,
  TransactionBuilder,
  hash,
  xdr,
} from "@stellar/stellar-sdk";
import {
  TestnetSponsorHistory,
  verifySponsorHistory,
  sponsorRpcReceipt,
} from "../src/funding-history.js";
import { SoranSponsorship } from "../src/funding-user.js";
import { FundingServiceClient } from "../src/funding-service.js";
import {
  sponsorIntentHash,
  sponsorQuoteToScVal,
  sponsoredIdentityToScVal,
} from "../src/funding-types.js";
import { hex } from "../src/native-codec.js";
const C = (n: number) => StrKey.encodeContract(new Uint8Array(32).fill(n));
const relay = Keypair.random().publicKey(),
  actor = Keypair.random().publicKey();
const intent = {
  name: "sam.nova",
  actor,
  routingId: null,
  generation: 0n,
  destination: { address: actor, memo: { type: "none" as const } },
  previous: null,
};
const quote = {
  network: hex(hash(new TextEncoder().encode(Networks.TESTNET))),
  funding: C(1),
  configRevision: 1n,
  fundId: "02".repeat(32),
  policyRevision: 1n,
  action: "reverse" as const,
  actor,
  nonce: 0n,
  quoteId: "03".repeat(32),
  intentHash: sponsorIntentHash("reverse", intent),
  registrar: C(2),
  resolver: C(3),
  relayer: relay,
  charge: 1000n,
  issuedLedger: 100,
  expiresLedger: 120,
};
const tx = new TransactionBuilder(new Account(relay, "40"), {
  fee: "100",
  networkPassphrase: Networks.TESTNET,
})
  .addOperation(
    new Contract(quote.funding).call(
      "sponsor_reverse",
      sponsorQuoteToScVal(quote),
      sponsoredIdentityToScVal(intent),
    ),
  )
  .setTimeout(60)
  .build();
const txHash = hex(tx.hash());
const ok = xdr.OperationResult.opInner(
  xdr.OperationResultTr.invokeHostFunction(
    xdr.InvokeHostFunctionResult.invokeHostFunctionSuccess(new Uint8Array(32)),
  ),
);
function record(success = true) {
  return {
    hash: txHash,
    ledger: 105,
    successful: success,
    envelope_xdr: tx.toXDR(),
    result_xdr: new xdr.TransactionResult({
      feeCharged: 100n,
      result: success
        ? xdr.TransactionResultResult.txSuccess([ok])
        : xdr.TransactionResultResult.txFailed([
            xdr.OperationResult.opBadAuth(),
          ]),
      ext: xdr.TransactionResultExt.v0(),
    }).toXDR("base64"),
  };
}
for (const success of [true, false]) {
  test(`old ${success ? "successful" : "failed"} quote is independently verified after RPC pruning`, async () => {
    const chain = new SoranSponsorship({
      fundingId: C(1),
      registryId: C(4),
      lookupId: C(5),
      primaryId: C(6),
    });
    chain.server.getTransaction = async () => ({ status: "NOT_FOUND" }) as any;
    chain.server.getLatestLedger = async () => ({ sequence: 200000 }) as any;
    const history = new TestnetSponsorHistory(async (url, options) => {
      assert.equal(
        String(url),
        `https://horizon-testnet.stellar.org/transactions/${txHash}`,
      );
      assert.equal(options?.redirect, "error");
      assert.equal(options?.credentials, "omit");
      return Response.json(record(success));
    });
    const service = new FundingServiceClient(
      "https://sponsor.invalid",
      chain,
      async () =>
        Response.json({
          id: quote.quoteId,
          transactionHash: txHash,
          status: success ? "success" : "failed",
        }),
      history,
    );
    assert.equal(
      (await service.status(quote)).status,
      success ? "success" : "failed",
    );
  });
}
for (const mutation of [
  "hash",
  "ledger",
  "before-quote",
  "result",
  "status",
  "envelope",
  "quote",
  "network",
] as const) {
  test(`historical evidence rejects mismatched ${mutation}`, () => {
    const r = record();
    let q = quote;
    if (mutation === "hash") r.hash = "00".repeat(32);
    if (mutation === "ledger") r.ledger = 201;
    if (mutation === "before-quote") r.ledger = 99;
    if (mutation === "status") r.successful = false;
    if (mutation === "envelope") r.envelope_xdr = "invalid";
    if (mutation === "quote") q = { ...quote, quoteId: "04".repeat(32) };
    if (mutation === "network") q = { ...quote, network: "00".repeat(32) };
    if (mutation === "result")
      r.result_xdr = new xdr.TransactionResult({
        feeCharged: 0n,
        result: xdr.TransactionResultResult.txBadSeq(),
        ext: xdr.TransactionResultExt.v0(),
      }).toXDR("base64");
    assert.equal(
      verifySponsorHistory(r, q, txHash, 200, Networks.TESTNET),
      null,
    );
  });
}
test("missing or unavailable history never becomes confirmation", async () => {
  const missing = new TestnetSponsorHistory(
    async () => new Response(null, { status: 404 }),
  );
  assert.equal(await missing.find(txHash, quote, 200, Networks.TESTNET), null);
  const offline = new TestnetSponsorHistory(async () => {
    throw Error("offline");
  });
  await assert.rejects(offline.find(txHash, quote, 200, Networks.TESTNET));
  await assert.rejects(
    missing.find("https://bad", quote, 200, Networks.TESTNET),
  );
  await assert.rejects(missing.find(txHash, quote, 200, Networks.PUBLIC));
});
test("API supplied receipt cannot replace an independent chain response", async () => {
  const chain = new SoranSponsorship({
    fundingId: C(1),
    registryId: C(4),
    lookupId: C(5),
    primaryId: C(6),
  });
  chain.server.getTransaction = async () => ({ status: "NOT_FOUND" }) as any;
  chain.server.getLatestLedger = async () => ({ sequence: 200 }) as any;
  const service = new FundingServiceClient(
    "https://sponsor.invalid",
    chain,
    async () =>
      Response.json({
        id: quote.quoteId,
        transactionHash: txHash,
        status: "success",
        receipt: record(),
      }),
    new TestnetSponsorHistory(async () => new Response(null, { status: 404 })),
  );
  await assert.rejects(service.status(quote), (e: any) => e.kind === "pending");
});
test("fee-bump history binds both outer envelope and inner transaction result", () => {
  const outer = TransactionBuilder.buildFeeBumpTransaction(
    Keypair.random().publicKey(),
    "200",
    tx,
    Networks.TESTNET,
  );
  const pair = new xdr.InnerTransactionResultPair({
    transactionHash: tx.hash(),
    result: new xdr.InnerTransactionResult({
      feeCharged: 100n,
      result: xdr.InnerTransactionResultResult.txSuccess([ok]),
      ext: xdr.InnerTransactionResultExt.v0(),
    }),
  });
  const result = new xdr.TransactionResult({
    feeCharged: 300n,
    result: xdr.TransactionResultResult.txFeeBumpInnerSuccess(pair),
    ext: xdr.TransactionResultExt.v0(),
  });
  const r = {
    ...record(),
    hash: hex(outer.hash()),
    envelope_xdr: outer.toXDR(),
    result_xdr: result.toXDR("base64"),
  };
  assert.equal(
    verifySponsorHistory(r, quote, txHash, 200, Networks.TESTNET)?.status,
    "success",
  );
  assert.equal(
    sponsorRpcReceipt(
      {
        status: "SUCCESS",
        ledger: 105,
        latestLedger: 200,
        txHash,
        envelopeXdr: outer.toEnvelope(),
        resultXdr: result,
      } as any,
      quote,
      txHash,
      Networks.TESTNET,
    ).transactionHash,
    txHash,
  );
  pair.transactionHash = new xdr.Hash(new Uint8Array(32));
  r.result_xdr = result.toXDR("base64");
  assert.equal(
    verifySponsorHistory(r, quote, txHash, 200, Networks.TESTNET),
    null,
  );
});
test("history transport keeps the browser fetch receiver", async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = function (this: unknown) {
    assert.equal(this, globalThis);
    return Promise.resolve(Response.json(record()));
  } as typeof fetch;
  try {
    assert.equal(
      (
        await new TestnetSponsorHistory().find(
          txHash,
          quote,
          200,
          Networks.TESTNET,
        )
      )?.status,
      "success",
    );
  } finally {
    globalThis.fetch = previous;
  }
});
