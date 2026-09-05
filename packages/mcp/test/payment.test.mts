import assert from "node:assert/strict";
import test from "node:test";
import { Asset, Networks, Keypair, StrKey } from "@stellar/stellar-sdk";
import { DEPLOYMENTS, Soran, SoranError, type PaymentDestination } from "@sorandomains/lookup";
import { SoranHolder } from "@sorandomains/holder";
import { registerReadTools, registerWriteTools } from "../src/tools.js";
const C = StrKey.encodeContract(Buffer.alloc(32, 1));
const G = Keypair.random().publicKey();
const payment: PaymentDestination = { address: G, memo: { type: "id", value: "18446744073709551615" } };
function fakeServer() {
  const handlers = new Map<string, (a: Record<string, unknown>) => Promise<unknown>>();
  const schemas = new Map<string, Record<string, { parse(v: unknown): unknown }>>();
  return { handlers, schemas, server: { tool(name: string, _description: string, schema: Record<string, { parse(v: unknown): unknown }>, handler: (a: Record<string, unknown>) => Promise<unknown>) { handlers.set(name, handler); schemas.set(name, schema); } } };
}
test("MCP payment readers preserve memo and complete verification", async () => {
  const originalResolve = Soran.prototype.resolvePayment;
  const originalVerify = Soran.prototype.verifyPayment;
  try {
    Soran.prototype.resolvePayment = async function (name) {
      assert.equal(name, "alice.nova");
      assert.equal((this as unknown as { registryId: string }).registryId, C);
      return payment;
    };
    Soran.prototype.verifyPayment = async (_name, expected) => { assert.deepEqual(expected, payment); return true; };
    const { server, handlers } = fakeServer();
    registerReadTools(server as never, { registryId: C });
    const result = await handlers.get("resolve_payment")!({ name: "alice.nova" }) as { content: Array<{ text: string }> };
    assert.deepEqual(JSON.parse(result.content[0].text).memo, payment.memo);
    const verify = await handlers.get("verify_payment")!({ name: "alice.nova", payment }) as { content: Array<{ text: string }> };
    assert.equal(JSON.parse(verify.content[0].text).verified, true);
    Soran.prototype.resolvePayment = async () => { throw new Error("PaymentNotConfigured"); };
    const failed = await handlers.get("resolve_payment")!({ name: "alice.nova" }) as { isError: boolean };
    assert.equal(failed.isError, true);
  } finally { Soran.prototype.resolvePayment = originalResolve; Soran.prototype.verifyPayment = originalVerify; }
});
test("MCP passes universal configuration, normalizes ASCII inputs and exposes structured errors", async () => {
  const original = Soran.prototype.lookup;
  try {
    Soran.prototype.lookup = async function () {
      assert.equal((this as unknown as { lookupId: string }).lookupId, C);
      throw new SoranError("inactive", "SIMULATION", 7, "NameInactive");
    };
    const { server, handlers, schemas } = fakeServer();
    registerReadTools(server as never, { lookupId: C });
    assert.equal(schemas.get("lookup_name")!.name.parse("ALICE.NOVA"), "alice.nova");
    assert.throws(() => schemas.get("lookup_name")!.name.parse("K.nova"));
    assert.throws(() => schemas.get("check_availability")!.namespace.parse("K"));
    const response = await handlers.get("lookup_name")!({ name: "alice.nova" }) as { content: Array<{ text: string }>; isError: boolean };
    assert.equal(response.isError, true);
    assert.equal(JSON.parse(response.content[0].text).contractError, "NameInactive");
  } finally { Soran.prototype.lookup = original; }
});
test("MCP set_payment carries Registry/network configuration and rejects malformed schema", async () => {
  const original = SoranHolder.prototype.setPayment;
  try {
    SoranHolder.prototype.setPayment = async function (name, destination) {
      assert.equal(name, "alice.nova"); assert.deepEqual(destination, payment);
      assert.equal((this as unknown as { registryId: string }).registryId, C);
      assert.equal((this as unknown as { passphrase: string }).passphrase, "custom network");
      return { hash: "hash", ledger: 1 };
    };
    const { server, handlers, schemas } = fakeServer();
    await registerWriteTools(server as never, { secret: Keypair.random().secret(), registryId: C, passphrase: "custom network" });
    const result = await handlers.get("set_payment")!({ name: "alice.nova", payment }) as { content: Array<{ text: string }> };
    assert.equal(JSON.parse(result.content[0].text).hash, "hash");
    assert.throws(() => schemas.get("set_payment")!.payment.parse({ address: G, memo: { type: "id", value: 42 } }));
    assert.throws(() => schemas.get("set_payment")!.payment.parse({ address: G, memo: { type: "none", value: "x" } }));
  } finally { SoranHolder.prototype.setPayment = original; }
});

test("MCP uses the verified default fee pin but never inherits it for a custom chain", async () => {
  const originalFetch = globalThis.fetch;
  const quote = { allocatorId: DEPLOYMENTS.testnet.allocatorId, token: Asset.native().contractId(Networks.TESTNET), amount: "50000000000", recipient: G, network: Networks.TESTNET };
  globalThis.fetch = async () => new Response(JSON.stringify(quote));
  try {
    for (const [opts, accepted] of [[{}, true], [{ registryId: C }, false], [{ passphrase: "custom network" }, false], [{ registryId: C, allocatorId: quote.allocatorId }, true]] as const) {
      const { server, handlers } = fakeServer();
      registerReadTools(server as never, opts);
      const result = await handlers.get("claim_fee_quote")!({}) as { isError?: boolean; content: Array<{ text: string }> };
      assert.equal(result.isError === true, !accepted);
      if (accepted) assert.equal(JSON.parse(result.content[0].text).expectedFee.allocatorId, quote.allocatorId);
    }
  } finally { globalThis.fetch = originalFetch; }
});
