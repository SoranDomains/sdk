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
async function setup(prep: Record<string, unknown>, ch = challenge(), deploymentVersion: 0 | 1 | null = 0, selectedRegistry = registry) {
  const handlers = new Map<string, (arg: any) => Promise<any>>();
  let submissions = 0, challenges = 0;
  const cancellations: Array<{ path: string; body: unknown }> = [];
  const saved = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const path = new URL(String(url)).pathname;
    let body: unknown;
    if (path.endsWith("/challenge")) { challenges++; body = { challengeId: "one", xdr: ch, network: Networks.TESTNET }; }
    else if (path.endsWith("/verify")) body = { token: "fake-test-session" };
    else if (path.endsWith("/prepare")) body = { ...prep, network: Networks.TESTNET };
    else if (path.endsWith("/cancel")) { cancellations.push({ path, body: JSON.parse(String(opts?.body)) }); body = { ok: prep.cancelOk ?? true }; }
    else if (path.endsWith("/submit")) {
      submissions++;
      const submitted = JSON.parse(String(opts?.body));
      const tx = TransactionBuilder.fromXDR(submitted.xdr ?? submitted.signedXdr, Networks.TESTNET);
      assert.equal(tx.signatures.length, 1);
      body = { ok: true, txHash: "accepted", registrarId: prep.predictedId };
    } else throw new Error(`unexpected fetch ${path}`);
    return new Response(JSON.stringify(body), { status: 200 });
  };
  await registerWriteTools({ tool(n: string, _d: string, _s: unknown, fn: (arg: any) => Promise<any>) { handlers.set(n, fn); } } as never, { secret: key.secret(), registryId: selectedRegistry, allocatorId: allocator, ...(deploymentVersion === null ? {} : { registryDeploymentSaltVersion: deploymentVersion }) });
  return { handlers, restore: () => { globalThis.fetch = saved; }, submissions: () => submissions, challenges: () => challenges, cancellations: () => cancellations };
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


test("MCP namespace-bound activation requires branded address and ignores API scheme", async () => {
  const selectedRegistry = "CDSORANCV3IFF3MKHJ7KI4MKEJOJZFMTDVAZCD5XFOR4WTGNXJJNOKQE";
  const node = await new Soran({ registryId: selectedRegistry }).namehash("nova");
  // Known public nonce from the new release's namespace-bound vanity search.
  const nonce = Uint8Array.from("99175732531c4ea5548b37dea1cdeae0b7c7f07856e7d04fad8a5f0000000000".match(/../g)!, byte => Number.parseInt(byte, 16));
  const field = (key: string, val: xdr.ScVal) => new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(key), val });
  const policy = xdr.ScVal.scvMap([field("default_term_secs", nativeToScVal(0n, { type: "u64" })), field("reclaimable", xdr.ScVal.scvBool(true)), field("trade_fee_bps", xdr.ScVal.scvU32(0)), field("tradeable", xdr.ScVal.scvBool(false)), field("transferable", xdr.ScVal.scvBool(true))]);
  const domain = new TextEncoder().encode("soran:namespace-deploy:v1\0");
  const encoded = new Uint8Array(91); encoded.set(domain); encoded[26] = 1;
  encoded.set(node, 27); encoded.set(nonce, 59);
  const address = (salt: Uint8Array) => StrKey.encodeContract(hash(xdr.HashIdPreimage.envelopeTypeContractId(new xdr.HashIdPreimageContractId({ networkId: hash(new TextEncoder().encode(Networks.TESTNET)), contractIdPreimage: xdr.ContractIdPreimage.contractIdPreimageFromAddress(new xdr.ContractIdPreimageFromAddress({ address: new Address(selectedRegistry).toScAddress(), salt })) })).toXDR()));
  const bound = address(hash(encoded)), raw = address(nonce);
  assert.equal(bound, "CCSORANUM6CHXIOLOTA65NNZK6PJNCY44354SXKIANFUY2VVKOPZUYSP");
  const args = [xdr.ScVal.scvBytes(node), new Address(wallet).toScVal(), policy, xdr.ScVal.scvBytes(nonce)];
  for (const [predictedId, configuredVersion, succeeds] of [[bound, 1, true], [raw, 1, false], [bound, 0, false], [bound, null, true]] as const) {
    const child = inv(predictedId, "__constructor", [new Address(selectedRegistry).toScVal(), args[0], new Address(wallet).toScVal(), args[1], policy, xdr.ScVal.scvBool(true)]);
    const state = await setup({ xdr: prepared(selectedRegistry, "deploy_registrar", args, [child]), predictedId, namespace: "nova", deploymentSaltVersion: 0 }, challenge(), configuredVersion, selectedRegistry);
    try {
      const result = await state.handlers.get("activate_namespace")!({ namespace: "nova", policy: "reclaimable", maxNetworkFeeStroops: "10000" });
      assert.equal(result.isError === true, !succeeds, result.content[0].text);
      assert.equal(state.submissions(), succeeds ? 1 : 0);
    } finally { state.restore(); }
  }
  // Correctly bound, but an unmined nonce must not bypass the branded default.
  const ordinaryNonce = new Uint8Array(32).fill(1); encoded.set(ordinaryNonce, 59);
  const ordinary = address(hash(encoded)); assert.doesNotMatch(ordinary, /^C[A-D]SORAN/);
  const ordinaryArgs = [...args.slice(0, 3), xdr.ScVal.scvBytes(ordinaryNonce)];
  const child = inv(ordinary, "__constructor", [new Address(selectedRegistry).toScVal(), args[0], new Address(wallet).toScVal(), args[1], policy, xdr.ScVal.scvBool(true)]);
  const state = await setup({ xdr: prepared(selectedRegistry, "deploy_registrar", ordinaryArgs, [child]), predictedId: ordinary, namespace: "nova" }, challenge(), 1, selectedRegistry);
  try {
    const result = await state.handlers.get("activate_namespace")!({ namespace: "nova", policy: "reclaimable", maxNetworkFeeStroops: "10000" });
    assert.equal(result.isError, true); assert.match(result.content[0].text, /vanity prefix/); assert.equal(state.submissions(), 0);
  } finally { state.restore(); }
});

test("MCP custom Registry activation requires a locally pinned scheme", async () => {
  const state = await setup({}, challenge(), null);
  try {
    const result = await state.handlers.get("activate_namespace")!({ namespace: "acme", policy: "reclaimable", maxNetworkFeeStroops: "10000" });
    assert.equal(result.isError, true); assert.match(result.content[0].text, /locally pinned/);
    assert.equal(state.submissions(), 0); assert.equal(state.challenges(), 0);
  } finally { state.restore(); }
});

test("MCP vanity generation reports pending without signing a deployment", async () => {
  for (const namespace of ["acme", "other"]) {
    const state = await setup({ pending: true, namespace, vanity: { status: "mining", attempts: 100 }, retryAfterMs: 2000 }, challenge(), 1);
    try {
      const result = await state.handlers.get("activate_namespace")!({ namespace: "acme", policy: "reclaimable", maxNetworkFeeStroops: "10000" });
      assert.equal(state.submissions(), 0);
      if (namespace === "acme") {
        assert.notEqual(result.isError, true);
        const body = JSON.parse(result.content[0].text);
        assert.equal(body.pending, true); assert.equal(body.activated, false); assert.equal(body.retryAfterMs, 2000);
      } else assert.equal(result.isError, true);
    } finally { state.restore(); }
  }
});


test("MCP vanity cancellation is namespace/role scoped and never submits a transaction", async () => {
  for (const role of ["registrar", "resolver"]) {
    const state = await setup({});
    try {
      const result = await state.handlers.get("cancel_namespace_activation")!({ namespace: "acme", role });
      assert.notEqual(result.isError, true);
      assert.deepEqual(state.cancellations(), [{ path: `/console/deployment/vanity/${role}/cancel`, body: { namespace: "acme" } }]);
      assert.equal(state.submissions(), 0);
      assert.equal(JSON.parse(result.content[0].text).onchainTransactionSubmitted, false);
    } finally { state.restore(); }
  }
  const state = await setup({ cancelOk: false });
  try {
    const result = await state.handlers.get("cancel_namespace_activation")!({ namespace: "acme", role: "registrar" });
    assert.equal(result.isError, true); assert.equal(state.submissions(), 0);
  } finally { state.restore(); }
});
