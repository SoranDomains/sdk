import assert from "node:assert/strict";
import test from "node:test";
import { Account, Address, Contract, Keypair, Networks, TransactionBuilder, xdr } from "@stellar/stellar-sdk";
import { authorizedInvocation, signEligibilityAuthorization, validateNativeTransaction, validateEligibilityAuthorization, assertSignedBodyUnchanged, type NativeAuthorizationPlan } from "../src/native-auth.js";
import { paymentDestinationToScVal, sc, struct } from "../src/native-codec.js";
import { destinationFromNative, encodeMuxedAddress } from "../src/payment.js";
import { scValToNative, StrKey } from "@stellar/stellar-sdk";

const claimant = Keypair.random(), approver = Keypair.random();
const C = (byte: number) => StrKey.encodeContract(new Uint8Array(32).fill(byte));
const registry = C(1), registrar = C(2), resolver = C(3), token = C(4);
const intent = struct({ claimant: sc.address(claimant.publicKey()), registry: sc.address(registry), request_id: sc.bytes(new Uint8Array(32).fill(7)) });
const plan: NativeAuthorizationPlan = {
  source: claimant.publicKey(), contract: registrar, method: "claim", args: [intent, xdr.ScVal.scvVec([])], maxFeeStroops: 50000000n,
  sourceInvocation: { contract: registrar, method: "claim", args: [intent], children: [{ contract: resolver, method: "initialize_destination", args: [sc.bytes(new TextEncoder().encode("alice")), sc.address(claimant.publicKey()), sc.u64(1n), paymentDestinationToScVal({ address: claimant.publicKey(), memo: { type: "none" } })] }] },
  eligibility: { account: approver.publicKey(), latestLedger: 100, maxExpirationLedger: 120, invocation: { contract: registrar, method: "claim", args: [intent] } },
};
const unsignedApproval = () => new xdr.SorobanAuthorizationEntry({ credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(new xdr.SorobanAddressCredentials({ address: new Address(approver.publicKey()).toScAddress(), nonce: 20n, signatureExpirationLedger: 0, signature: xdr.ScVal.scvVoid() })), rootInvocation: authorizedInvocation(plan.eligibility!.invocation) });
const sourceAuth = () => new xdr.SorobanAuthorizationEntry({ credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(), rootInvocation: authorizedInvocation(plan.sourceInvocation) });
function tx(entries: xdr.SorobanAuthorizationEntry[], args = plan.args, method = "claim") {
  return new TransactionBuilder(new Account(claimant.publicKey(), "0"), { networkPassphrase: Networks.TESTNET, fee: "100" }).addOperation(new Contract(registrar).call(method, ...args)).setTimeout(60).build();
}
function withAuth(entries: xdr.SorobanAuthorizationEntry[], args = plan.args, method = "claim") {
  const built = tx(entries,args,method);
  const op = built.operations[0]; assert.equal(op.type, "invokeHostFunction");
  return TransactionBuilder.cloneFrom(built, { networkPassphrase: Networks.TESTNET }).clearOperations().addOperation(new Contract(registrar).call(method,...args)).build();
}
import { Operation } from "@stellar/stellar-sdk";
function prepared(entries: xdr.SorobanAuthorizationEntry[], args = plan.args, method = "claim") {
  return new TransactionBuilder(new Account(claimant.publicKey(), "0"), { networkPassphrase: Networks.TESTNET, fee: "100" }).addOperation(Operation.invokeContractFunction({ contract: registrar, function: method, args, auth: entries })).setTimeout(60).build();
}

test("native second approval signs only exact claim authorization with bounded expiration", async () => {
  const approval = await signEligibilityAuthorization(unsignedApproval(), plan.eligibility!, approver, 110, Networks.TESTNET);
  validateEligibilityAuthorization(approval, plan.eligibility!);
  validateNativeTransaction(prepared([sourceAuth(),approval]),plan);
  assert.equal(approval.credentials.type,"sorobanCredentialsAddress");
});
for (const attack of ["wrong-account","nested-transfer","wrong-method","wrong-intent","expired","too-long","wrong-credential"] as const) test(`eligibility helper rejects ${attack}`,async()=>{
  const entry=unsignedApproval(); let expected=plan.eligibility!;
  if(attack==="wrong-account")expected={...expected,account:claimant.publicKey()};
  if(attack==="nested-transfer")entry.rootInvocation.subInvocations=[authorizedInvocation({contract:token,method:"transfer",args:[sc.address(approver.publicKey()),sc.address(claimant.publicKey()),sc.i128(1n)]})];
  if(attack==="wrong-method")entry.rootInvocation.function=authorizedInvocation({...expected.invocation,method:"configure_claims"}).function;
  if(attack==="wrong-intent")entry.rootInvocation.function=authorizedInvocation({...expected.invocation,args:[sc.u64(42n)]}).function;
  if(attack==="wrong-credential")entry.credentials=xdr.SorobanCredentials.sorobanCredentialsSourceAccount();
  await assert.rejects(signEligibilityAuthorization(entry,expected,approver,attack==="expired"?100:attack==="too-long"?121:110,Networks.TESTNET));
});
for(const attack of ["extra-auth","missing-holder","missing-approver","holder-children","holder-root","extra-operation-argument","different-call","unknown-credential"] as const)test(`claim transaction refuses ${attack} before wallet`,async()=>{
  const approval=await signEligibilityAuthorization(unsignedApproval(),plan.eligibility!,approver,110,Networks.TESTNET);
  const holder=sourceAuth();let auth=[holder,approval],args=plan.args,method="claim";
  if(attack==="extra-auth")auth.push(sourceAuth());
  if(attack==="missing-holder")auth=[approval];
  if(attack==="missing-approver")auth=[holder];
  if(attack==="holder-children")holder.rootInvocation.subInvocations=[];
  if(attack==="holder-root")holder.rootInvocation.function=authorizedInvocation({...plan.sourceInvocation,args:[sc.u64(9n)]}).function;
  if(attack==="extra-operation-argument")args=[...args,sc.u64(1n)];
  if(attack==="different-call")method="issue";
  if(attack==="unknown-credential"&&approval.credentials.type==="sorobanCredentialsAddress")approval.credentials=xdr.SorobanCredentials.sorobanCredentialsAddressV2(approval.credentials.address);
  assert.throws(()=>validateNativeTransaction(prepared(auth,args,method),plan));
});
test("wallet cannot replace the reviewed native transaction body",async()=>{
  const approval=await signEligibilityAuthorization(unsignedApproval(),plan.eligibility!,approver,110,Networks.TESTNET);
  const original=prepared([sourceAuth(),approval]); original.sign(claimant);
  assert.equal(assertSignedBodyUnchanged(original,original.toXDR(),Networks.TESTNET).hash().length,32);
  const replacement=prepared([sourceAuth(),approval],[sc.u64(8n)]); replacement.sign(claimant);
  assert.throws(()=>assertSignedBodyUnchanged(original,replacement.toXDR(),Networks.TESTNET),/changed/);
});
for(const [description,payment] of [
  ["G",{address:claimant.publicKey(),memo:{type:"none"}}],
  ["G-ID",{address:claimant.publicKey(),memo:{type:"id",value:"18446744073709551615"}}],
  ["G-text",{address:claimant.publicKey(),memo:{type:"text",value:" customer-420 "}}],
  ["G-hash",{address:claimant.publicKey(),memo:{type:"hash",value:"01".repeat(32)}}],
  ["C",{address:C(9),memo:{type:"none"}}],
  ...["0","420","9007199254740993","18446744073709551615"].map(id=>["M-"+id,{address:encodeMuxedAddress(claimant.publicKey(),id),memo:{type:"none"}}]),
] as const)test(`native destination struct preserves ${description}`,()=>{
  assert.deepEqual(destinationFromNative(scValToNative(paymentDestinationToScVal(payment as any))),payment);
});
