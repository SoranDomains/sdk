import assert from "node:assert/strict";
import test from "node:test";
import { Keypair, Networks, SorobanDataBuilder, StrKey, hash, xdr } from "@stellar/stellar-sdk";
import { FundingReader } from "../src/funding-reader.js";
import { SoranSponsorship } from "../src/funding-user.js";
import { FundingServiceClient } from "../src/funding-service.js";
import { TestnetSponsorHistory } from "../src/funding-history.js";
import { FundingError, sponsorIntentHash } from "../src/funding-types.js";
import { hex } from "../src/native-codec.js";

const C = (n: number) => StrKey.encodeContract(new Uint8Array(32).fill(n));
const actor = Keypair.random().publicKey(), relay = Keypair.random().publicKey();
const options = { fundingId: C(1), registryId: C(6), lookupId: C(4), primaryId: C(5) };
const isFundingError = (kind: string, message: RegExp) => (e: unknown) => e instanceof FundingError && e.kind === kind && message.test(e.message);

const simulation = (extra: Record<string, unknown> = {}) => ({ _parsed: true, transactionData: new SorobanDataBuilder(), latestLedger: 10, minResourceFee: "0", events: [],
  result: { auth: [], retval: xdr.ScVal.scvU32(1) }, ...extra });
const readerFor = (sim: unknown) => new FundingReader({ ...options, server: { simulateTransaction: async () => sim } as never });

test("a simulation that needs a restore preamble is archived state, not a live read", async () => {
  assert.deepEqual(await readerFor(simulation()).read(C(1), "version", []), { value: 1, ledger: 10 });
  const restore = simulation({ restorePreamble: { minResourceFee: "100", transactionData: new SorobanDataBuilder() } });
  await assert.rejects(readerFor(restore).read(C(1), "version", []), isFundingError("unavailable", /archived/));
  await assert.rejects(readerFor({ _parsed: true, error: "boom", latestLedger: 10 }).read(C(1), "version", []), isFundingError("unavailable", /boom/));
  await assert.rejects(readerFor(simulation()).read(C(1), "version", [], 11), isFundingError("unavailable", /stale/));
});

const intent = { name: "sam.nova", actor, routingId: null, generation: 0n, destination: { address: actor, memo: { type: "none" as const } }, previous: null };
const chain = new SoranSponsorship(options);
const quote = { network: hex(hash(new TextEncoder().encode(Networks.TESTNET))), funding: C(1), configRevision: 1n, fundId: "02".repeat(32), policyRevision: 1n,
  action: "reverse" as const, actor, nonce: 0n, quoteId: "03".repeat(32), intentHash: sponsorIntentHash("reverse", intent), registrar: C(2), resolver: C(3),
  relayer: relay, charge: 1000n, issuedLedger: 100, expiresLedger: 120 };
/** A body of `chunks` 64 KiB pieces that records how much the consumer pulled and whether it cancelled. */
function streaming(chunks: number, init: ResponseInit = {}) {
  const seen = { pulled: 0, cancelled: false };
  const body = new ReadableStream<Uint8Array>({
    pull(controller) { if (seen.pulled >= chunks) return controller.close(); seen.pulled++; controller.enqueue(new Uint8Array(65_536).fill(32)); },
    cancel() { seen.cancelled = true; },
  });
  return { seen, response: new Response(body, init) };
}

test("an oversized service response is refused without buffering it, and a submit stays pending", async () => {
  for (const [label, run, kind] of [
    ["status", (client: FundingServiceClient) => client.status(quote), "unavailable"],
    ["submit", (client: FundingServiceClient) => client.submit(quote, "AAAA"), "pending"],
  ] as const) {
    const { seen, response } = streaming(400);
    const client = new FundingServiceClient("https://sponsor.invalid", chain, async () => response);
    await assert.rejects(run(client), isFundingError(kind, /too large/), label);
    assert.ok(seen.cancelled, `${label}: the body must be cancelled`);
    assert.ok(seen.pulled <= 8, `${label}: read ${seen.pulled} chunks of a 400 chunk body`);
  }
  // A declared length over the cap is refused before any body is read.
  const declared = streaming(1, { headers: { "content-length": "999999999" } });
  await assert.rejects(new FundingServiceClient("https://sponsor.invalid", chain, async () => declared.response).status(quote), isFundingError("unavailable", /too large/));
  assert.ok(declared.seen.cancelled && declared.seen.pulled <= 1, "a stream primes one chunk; the consumer must not read further");
  // Ordinary answers are untouched.
  const ok = new FundingServiceClient("https://sponsor.invalid", chain, async () => Response.json({ id: quote.quoteId, status: "quoted", transactionHash: null }));
  assert.equal((await ok.status(quote)).status, "quoted");
  const notJson = new FundingServiceClient("https://sponsor.invalid", chain, async () => new Response("<html>502</html>", { status: 502 }));
  await assert.rejects(notJson.submit(quote, "AAAA"), isFundingError("pending", /not valid JSON/));
});

test("the sponsor history reader stops at its size cap instead of reading the whole response", async () => {
  const txHash = "ab".repeat(32);
  const { seen, response } = streaming(200);
  await assert.rejects(new TestnetSponsorHistory(async () => response).find(txHash, quote, 200, Networks.TESTNET), isFundingError("unavailable", /too large/));
  assert.ok(seen.cancelled);
  assert.ok(seen.pulled <= 12, `read ${seen.pulled} chunks of a 200 chunk body`);
  assert.equal(await new TestnetSponsorHistory(async () => new Response(null, { status: 404 })).find(txHash, quote, 200, Networks.TESTNET), null);
});
