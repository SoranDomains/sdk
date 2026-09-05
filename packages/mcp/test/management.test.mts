import assert from "node:assert/strict";
import test from "node:test";
import { Account, Address, Keypair, Networks, Operation, StrKey, TransactionBuilder, hash, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { Soran } from "@sorandomains/lookup";
import { registerWriteTools } from "../src/tools.js";
const key = Keypair.random(), wallet = key.publicKey();
const registry = StrKey.encodeContract(new Uint8Array(32).fill(4)), allocator = StrKey.encodeContract(new Uint8Array(32).fill(5));
const bytes = (v: string) => xdr.ScVal.scvBytes(new TextEncoder().encode(v));
function inv(id: string, fn: string, args: xdr.ScVal[], subInvocations: xdr.SorobanAuthorizedInvocation[] = []) {
  return new xdr.SorobanAuthorizedInvocation({ function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(new xdr.InvokeContractArgs({ contractAddress: new Address(id).toScAddress(), functionName: fn, args })), subInvocations });
}
function prepared(id: string, fn: string, args: xdr.ScVal[], sub: xdr.SorobanAuthorizedInvocation[] = [], fee = "1000") {
  const auth = new xdr.SorobanAuthorizationEntry({ credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(), rootInvocation: inv(id, fn, args, sub) });
  return new TransactionBuilder(new Account(wallet, "7"), { fee, networkPassphrase: Networks.TESTNET }).addOperation(Operation.invokeContractFunction({ contract: id, function: fn, args, auth: [auth] })).setTimeout(60).build().toXDR();
}
function challenge(sequence = "0", name = "soran.domains auth") {
  return new TransactionBuilder(new Account(wallet, sequence), { fee: "100", networkPassphrase: Networks.TESTNET }).addOperation(Operation.manageData({ name, value: "nonce" })).setTimeout(300).build().toXDR();
}
async function setup(prep: Record<string, unknown>, ch = challenge()) {
  const handlers = new Map<string, (arg: any) => Promise<any>>();
  let submissions = 0, challenges = 0;
  const saved = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const path = new URL(String(url)).pathname;
    let body: unknown;
    if (path.endsWith("/challenge")) { challenges++; body = { challengeId: "one", xdr: ch, network: Networks.TESTNET }; }
    else if (path.endsWith("/verify")) body = { token: "fake-test-session" };
    else if (path.endsWith("/prepare")) body = { ...prep, network: Networks.TESTNET };
    else if (path.endsWith("/submit")) {
      submissions++;
      const submitted = JSON.parse(String(opts?.body));
      const tx = TransactionBuilder.fromXDR(submitted.xdr ?? submitted.signedXdr, Networks.TESTNET);
      assert.equal(tx.signatures.length, 1);
      body = { ok: true, txHash: "accepted", registrarId: prep.predictedId };
    } else throw new Error(`unexpected fetch ${path}`);
    return new Response(JSON.stringify(body), { status: 200 });
  };
  await registerWriteTools({ tool(n: string, _d: string, _s: unknown, fn: (arg: any) => Promise<any>) { handlers.set(n, fn); } } as never, { secret: key.secret(), registryId: registry, allocatorId: allocator });
  return { handlers, restore: () => { globalThis.fetch = saved; }, submissions: () => submissions, challenges: () => challenges };
}
test("MCP withdrawal signs only selected Allocator/label and bounded fee", async () => {
  for (const [encoded, succeeds] of [[prepared(allocator, "withdraw", [bytes("acme")]), true], [prepared(registry, "withdraw", [bytes("acme")]), false], [prepared(allocator, "withdraw", [bytes("else")]), false], [prepared(allocator, "withdraw", [bytes("acme")], [], "10001"), false], [prepared(allocator, "withdraw", [bytes("acme")], [inv(registry, "arbitrary", [])]), false]] as const) {
    const state = await setup({ xdr: encoded });
    try {
      const result = await state.handlers.get("withdraw_claim")!({ label: "acme", maxNetworkFeeStroops: "10000" });
      assert.equal(result.isError === true, !succeeds); assert.equal(state.submissions(), succeeds ? 1 : 0);
    } finally { state.restore(); }
  }
});
test("MCP activation pins namespace/policy/treasury/predicted contract and nested constructor", async () => {
  const node = await new Soran({ registryId: registry }).namehash("acme");
  const salt = new Uint8Array(32).fill(1);
  const field = (key: string, val: xdr.ScVal) => new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(key), val });
  const policy = xdr.ScVal.scvMap([field("default_term_secs", nativeToScVal(0n, { type: "u64" })), field("reclaimable", xdr.ScVal.scvBool(true)), field("trade_fee_bps", xdr.ScVal.scvU32(0)), field("tradeable", xdr.ScVal.scvBool(false)), field("transferable", xdr.ScVal.scvBool(true))]);
  const preimage = xdr.HashIdPreimage.envelopeTypeContractId(new xdr.HashIdPreimageContractId({ networkId: hash(new TextEncoder().encode(Networks.TESTNET)), contractIdPreimage: xdr.ContractIdPreimage.contractIdPreimageFromAddress(new xdr.ContractIdPreimageFromAddress({ address: new Address(registry).toScAddress(), salt })) }));
  const predictedId = StrKey.encodeContract(hash(preimage.toXDR()));
  const args = [xdr.ScVal.scvBytes(node), new Address(wallet).toScVal(), policy, xdr.ScVal.scvBytes(salt)];
  const child = inv(predictedId, "__constructor", [new Address(registry).toScVal(), args[0], new Address(wallet).toScVal(), args[1], policy, xdr.ScVal.scvBool(true)]);
  for (const [namespace, selectedPolicy, predicted, children, succeeds] of [["acme", "reclaimable", predictedId, [child], true], ["else", "reclaimable", predictedId, [child], false], ["acme", "permanent", predictedId, [child], false], ["acme", "reclaimable", registry, [child], false], ["acme", "reclaimable", predictedId, [child, child], false], ["acme", "reclaimable", predictedId, [inv(registry, "bad", [])], false]] as const) {
    const state = await setup({ xdr: prepared(registry, "deploy_registrar", args, [...children]), predictedId: predicted });
    try { const result = await state.handlers.get("activate_namespace")!({ namespace, policy: selectedPolicy, maxNetworkFeeStroops: "10000" }); assert.equal(result.isError === true, !succeeds, result.content[0].text); assert.equal(state.submissions(), succeeds ? 1 : 0); } finally { state.restore(); }
  }
});
test("MCP sign-in rejects real sequence or different authentication domain before prepare", async () => {
  for (const ch of [challenge("7"), challenge("0", "other domain")]) {
    const state = await setup({ xdr: prepared(allocator, "withdraw", [bytes("acme")]) }, ch);
    try { const result = await state.handlers.get("withdraw_claim")!({ label: "acme", maxNetworkFeeStroops: "10000" }); assert.equal(result.isError, true); assert.equal(state.submissions(), 0); } finally { state.restore(); }
  }
});
