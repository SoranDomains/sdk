import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { Networks, rpc } from "@stellar/stellar-sdk";
import { stringifyNativeIntent } from "@sorandomains/holder";
import { registerReadTools, type ReadToolOptions, type ToolRegistrar } from "../src/tools.js";
import { recoverHistoricalSavedClaim } from "../src/historical.js";
import { fixture, original, lookup, target } from "./helpers/historical-sdk.js";

const intentJson = stringifyNativeIntent(original), originalTransactionHash = "ef".repeat(32);
function registered(options: ReadToolOptions = { lookupId: lookup }) {
  type Result = { content: Array<{ type: "text"; text: string }>; isError?: boolean };
  const tools = new Map<string, { schema: z.AnyZodObject; callback: (args: unknown) => Promise<Result> }>();
  const server = { tool(name: string, _description: string, schema: z.ZodRawShape, callback: (args: unknown) => Promise<Result>) {
    tools.set(name, { schema: z.object(schema), callback });
  } } as ToolRegistrar;
  registerReadTools(server, options);
  const invoke = async (args: unknown) => {
    const entry = tools.get("recover_historical_claim")!;
    const result = await entry.callback(entry.schema.parse(args));
    return { ...result, body: JSON.parse(result.content[0].text) };
  };
  return { tools, invoke };
}
async function withChain<T>(run: (f: ReturnType<typeof fixture>) => Promise<T>) {
  const f = fixture();
  const mocked = (f.client as unknown as { server: rpc.Server }).server;
  const oldSimulate = rpc.Server.prototype.simulateTransaction;
  const oldEntries = rpc.Server.prototype.getLedgerEntries;
  const oldSend = rpc.Server.prototype.sendTransaction;
  const oldAccount = rpc.Server.prototype.getAccount;
  rpc.Server.prototype.simulateTransaction = mocked.simulateTransaction.bind(mocked);
  rpc.Server.prototype.getLedgerEntries = mocked.getLedgerEntries.bind(mocked);
  rpc.Server.prototype.sendTransaction = async () => { throw new Error("read tool must not submit"); };
  rpc.Server.prototype.getAccount = async () => { throw new Error("read tool must not prepare writes"); };
  try { return await run(f); } finally {
    rpc.Server.prototype.simulateTransaction = oldSimulate;
    rpc.Server.prototype.getLedgerEntries = oldEntries;
    rpc.Server.prototype.sendTransaction = oldSend;
    rpc.Server.prototype.getAccount = oldAccount;
  }
}

test("historical recovery is a keyless read tool with no caller deployment or URL arguments", () => {
  const { tools } = registered();
  assert(tools.has("recover_historical_claim")); assert(!tools.has("claim_username"));
  assert.deepEqual(Object.keys(tools.get("recover_historical_claim")!.schema.shape).sort(), ["intentJson", "originalTransactionHash"]);
});
test("actual packed Holder verifies original history through configured canonical Lookup", async () => withChain(async f => {
  const result = await registered().invoke({ intentJson, originalTransactionHash });
  assert.equal(result.isError, undefined); assert.equal(result.body.status, "confirmed");
  assert.equal(result.body.receipt.ledger, 100); assert.equal(result.body.originalIntentJson, intentJson);
  assert.equal(result.body.originalTransactionHash, originalTransactionHash);
  assert.equal(result.body.retryAllowed, false); assert.equal(result.body.submitted, false);
  assert(f.calls.filter(method => method === "registry").length >= 2);
  assert.deepEqual(f.counts(), { signs: 0, sends: 0 });
}));
test("verified absence retains the original intent and hash and does not authorize retry", async () => withChain(async f => {
  f.values.claim_receipt = null;
  const result = await registered().invoke({ intentJson, originalTransactionHash });
  assert.equal(result.body.status, "not_found"); assert.equal(result.body.receipt, null);
  assert.equal(result.body.originalIntentJson, intentJson); assert.equal(result.body.originalTransactionHash, originalTransactionHash);
  assert.equal(result.body.retryAllowed, false); assert.equal(result.body.submitted, false);
}));
test("active, unsealed, unfrozen, stale and untrusted sources stay unavailable", async () => withChain(async f => {
  const checks = [
    () => { f.values.migration_active = true; },
    () => { f.values.migration_active = false; f.status.sealed = false; },
    () => { f.status.sealed = true; f.values.migration_export_frozen = false; },
    () => { f.values.migration_export_frozen = true; f.ledgers.claim_receipt = 189; },
    () => { delete f.ledgers.claim_receipt; f.hashes[original.context.registrar] = new Uint8Array(32); },
  ];
  for (const change of checks) {
    change(); const result = await registered().invoke({ intentJson, originalTransactionHash });
    assert.equal(result.isError, true); assert.equal(result.body.status, "unavailable");
    assert.equal(result.body.originalIntentJson, intentJson); assert.equal(result.body.originalTransactionHash, originalTransactionHash);
    assert.equal(result.body.retryAllowed, false); assert.equal(result.body.submitted, false);
  }
}));
test("substituted source intent or memo cannot borrow an existing receipt", async () => withChain(async () => {
  const changed = JSON.parse(intentJson); changed.destination.memo = { type: "none" };
  const result = await registered().invoke({ intentJson: JSON.stringify(changed), originalTransactionHash });
  assert.equal(result.isError, true); assert.equal(result.body.status, "unavailable");
}));
test("custom configuration requires an explicit Lookup and network mismatch fails before RPC", async () => {
  for (const options of [{ rpcUrl: "https://configured.invalid" }, { registryId: target }, { lookupId: null }])
    await assert.rejects(recoverHistoricalSavedClaim(intentJson, options), /trusted Lookup/);
  await assert.rejects(recoverHistoricalSavedClaim(intentJson, { passphrase: Networks.PUBLIC, lookupId: lookup }), /different configured network/);
});
test("caller override fields and later mutable server options cannot replace trusted Lookup", async () => withChain(async () => {
  const options = { lookupId: lookup }; const tool = registered(options); options.lookupId = target;
  const result = await tool.invoke({ intentJson, rpcUrl: "https://caller.invalid", lookupId: target, secret: "ignored" });
  assert.equal(result.body.status, "confirmed");
}));
test("malformed references and hashes are bounded before network work", async () => {
  const { tools, invoke } = registered(); const schema = tools.get("recover_historical_claim")!.schema;
  assert(!schema.safeParse({ intentJson: "x".repeat(16385) }).success);
  assert(!schema.safeParse({ intentJson, originalTransactionHash: "bad" }).success);
  const result = await invoke({ intentJson: "{}", originalTransactionHash });
  assert.equal(result.isError, true); assert.equal(result.body.retryAllowed, false);
});
