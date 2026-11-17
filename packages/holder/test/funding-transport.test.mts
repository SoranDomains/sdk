import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { rpc, StrKey } from "@stellar/stellar-sdk";
import { FundingReader } from "../src/funding-reader.js";

const contract = StrKey.encodeContract(new Uint8Array(32));
const options = { fundingId: contract, registryId: contract, lookupId: contract, primaryId: contract };

test("owned FundingReader transport actually aborts a stalled HTTP request", { timeout: 22_000 }, async t => {
  const reader = new FundingReader(options);
  assert.equal(reader.server.httpClient.defaults.timeout, 15_000);
  // Use only isolated loopback, without making a Stellar request or signing.
  const server = createServer(() => {});
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const port = (server.address() as { port: number }).port;
  const started = performance.now();
  await assert.rejects(reader.server.httpClient.get(`http://127.0.0.1:${port}/stalled`), (error: any) => {
    assert.equal(error.code, "ECONNABORTED");
    return true;
  });
  assert.ok(performance.now() - started >= 14_000);
  assert.ok(performance.now() - started < 21_000);
});

test("caller-supplied transports retain their existing deadline", () => {
  const server = new rpc.Server("https://rpc.invalid");
  server.httpClient.defaults.timeout = 77_000;
  assert.equal(new FundingReader({ ...options, server }).server, server);
  assert.equal(server.httpClient.defaults.timeout, 77_000);
});
