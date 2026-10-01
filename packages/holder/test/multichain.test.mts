import assert from "node:assert/strict";
import test from "node:test";
import { Account, Address, Keypair, StrKey, hash, scValToNative, xdr, SorobanDataBuilder, TransactionBuilder } from "@stellar/stellar-sdk";
import { SoranHolder, HolderError, DEPLOYMENTS, encodeChainAddress } from "../src/index.js";
const kp=Keypair.random(),G=kp.publicKey(),RESOLVER=StrKey.encodeContract(new Uint8Array(32).fill(1)),REGISTRAR=StrKey.encodeContract(new Uint8Array(32).fill(2));
const REGISTRY=DEPLOYMENTS.testnet.registryId;
const nsNode=new Uint8Array(hash(Uint8Array.from([...new Uint8Array(32),...hash(new TextEncoder().encode("solo"))])));
const address="0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
function client(overrides: Record<string,unknown>={}) {
 const s=new SoranHolder({signer:{publicKey:()=>G,signTransaction:async()=>{throw Error("unexpected signing");}}});const writes:any[]=[];
 Object.assign(s,{read:async(id:string,fn:string)=>{
  if(Object.hasOwn(overrides,fn)){const value=overrides[fn];if(value instanceof Error)throw value;return value;}
  if(fn==="resolver_of")return RESOLVER;if(fn==="registrar_of")return REGISTRAR;if(fn==="registry")return REGISTRY;
  if(fn==="authority")return REGISTRAR;if(fn==="anchors")return [REGISTRY,nsNode];if(fn==="multichain_version")return 1;if(fn==="chain_policy")return [60,2147492101];
  throw Error(`unexpected ${fn}`);
 },invoke:async(id:string,fn:string,args:unknown[],errors:any)=>{writes.push({id,fn,args:args.map(arg=>scValToNative(arg as never)),errors});return {hash:"hash",ledger:1};}});
 return {s,writes};
}
test("set and clear encode one native invocation, with holder authorization and explicit u32 network",async()=>{
 const {s,writes}=client();await s.setChainAddress("FRED.SOLO","base",address);
 assert.equal(writes[0].id,RESOLVER);assert.equal(writes[0].fn,"set_chain_address");
 assert.deepEqual(writes[0].args.slice(0,3),["fred.solo",G,2147492101]);assert.deepEqual(new Uint8Array(writes[0].args[3]),encodeChainAddress("base",address));assert.equal(writes[0].errors[34],"ChainDisabled");
 await s.clearChainAddress("FRED.SOLO","base");assert.equal(writes[1].fn,"clear_chain_address");assert.deepEqual(writes[1].args,["fred.solo",G,2147492101]);
});
test("disabled stops publishing but permits clearing; version and route errors fail before writes",async()=>{
 const disabled=client({chain_policy:[]});await assert.rejects(disabled.s.setChainAddress("fred.solo","ethereum",address),(e:unknown)=>e instanceof HolderError&&e.codeName==="ChainDisabled");
 assert.equal(disabled.writes.length,0);await disabled.s.clearChainAddress("fred.solo","ethereum");assert.equal(disabled.writes.length,1);
 for(const overrides of [{resolver_of:null},{registrar_of:null},{registry:RESOLVER},{authority:RESOLVER},{anchors:[REGISTRY,new Uint8Array(32)]},{multichain_version:1n},{multichain_version:2},{chain_policy:[60,60]}]){
  const {s,writes}=client(overrides);await assert.rejects(s.setChainAddress("fred.solo","ethereum",address));assert.equal(writes.length,0);
 }
});
test("invalid address and unsupported network fail before any network or signing work",async()=>{
 const {s}=client();Object.assign(s,{read:()=>{throw Error("must not read");}});
 await assert.rejects(s.setChainAddress("fred.solo","ethereum","0x"+"0".repeat(40)),/zero EVM/);
 await assert.rejects(s.setChainAddress("fred.solo","stellar" as never,address),/unsupported/);
});
test("contract rejection during simulation never signs or retries with text records",async()=>{
 const {s}=client();let signed=0,sent=0;
 // Restore actual invocation and supply only a rejecting RPC simulation.
 Object.assign(s,{invoke:(SoranHolder.prototype as any).invoke,signer:{publicKey:()=>G,signTransaction:async()=>{signed++;throw Error("must not sign");}},server:{
  getAccount:async()=>new Account(G,"0"),simulateTransaction:async(tx:any)=>{assert.equal(tx.operations[0].func.invokeContract.functionName.toString(),"set_chain_address");return {error:"Error(Contract, #34)"};},sendTransaction:async()=>{sent++;throw Error("must not send");}
 }});
 await assert.rejects(s.setChainAddress("fred.solo","ethereum",address),(e:unknown)=>e instanceof HolderError&&e.code===34&&e.codeName==="ChainDisabled");assert.equal(signed,0);assert.equal(sent,0);
});

for(const action of ["set", "clear"])for(const tamper of ["none","auth-args","auth-nested","signer-body"] as const)test(`multichain ${action} signing validates exact intent: ${tamper}`,async()=>{
 const {s}=client();let signed=0,sent=0;
 Object.assign(s,{invoke:(SoranHolder.prototype as any).invoke,signer:{publicKey:()=>G,signTransaction:async(raw:string,{networkPassphrase}:{networkPassphrase:string})=>{
  signed++;const original=TransactionBuilder.fromXDR(raw,networkPassphrase);
  const tx=tamper==="signer-body"?TransactionBuilder.cloneFrom(original as any,{networkPassphrase,fee:"999"}).build():original;tx.sign(kp);return tx.toXDR();
 }},server:{getAccount:async()=>new Account(G,"0"),simulateTransaction:async(tx:any)=>{
  const original=tx.operations[0].func.invokeContract;
  const args=original.args.map((arg:xdr.ScVal)=>xdr.ScVal.fromXDR(arg.toXDR()));
  if(tamper==="auth-args")args[args.length-1]=xdr.ScVal.scvVoid();
  const call=new xdr.InvokeContractArgs({contractAddress:original.contractAddress,functionName:original.functionName,args});
  const root=new xdr.SorobanAuthorizedInvocation({function:xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(call),subInvocations:[]});
  if(tamper==="auth-nested")root.subInvocations=[new xdr.SorobanAuthorizedInvocation({function:root.function,subInvocations:[]})];
  const auth=new xdr.SorobanAuthorizationEntry({credentials:xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),rootInvocation:root});
  return {_parsed:true,transactionData:new SorobanDataBuilder(),minResourceFee:"0",result:{auth:[auth],retval:xdr.ScVal.scvVoid()},events:[],latestLedger:1};
 },sendTransaction:async(tx:any)=>{sent++;assert(kp.verify(tx.hash(),tx.signatures[0].signature));return {status:"PENDING"};}},confirm:async()=>({ledger:2,returnValue:null,events:[]})});
 const run=()=>action==="set"?s.setChainAddress("fred.solo","ethereum",address):s.clearChainAddress("fred.solo","ethereum");
 if(tamper==="none"){assert.equal((await run()).ledger,2);assert.equal(signed,1);assert.equal(sent,1);}
 else {await assert.rejects(run(),/differs from selected intent|signer changed/);assert.equal(signed,tamper==="signer-body"?1:0);assert.equal(sent,0);}
});

for(const [code,codeName] of [[37,"ChainContextMismatch"],[38,"ChainUnavailable"],[99,null]] as const)
 test(`failed policy read preserves Resolver error ${code}/${codeName}`,async()=>{
  const {s,writes}=client();let simulations=0;
  Object.assign(s,{read:(SoranHolder.prototype as any).read,multichainResolverOf:async()=>RESOLVER,server:{simulateTransaction:async(tx:any)=>{
   simulations++;const call=tx.operations[0].func.invokeContract;
   assert.equal(Address.fromScAddress(call.contractAddress).toString(),RESOLVER);
   assert.equal(call.functionName.toString(),"chain_policy");assert.equal(call.args.length,0);
   return {error:`Error(Contract, #${code})`};
  }}});
  await assert.rejects(s.setChainAddress("fred.solo","ethereum",address),(e:unknown)=>e instanceof HolderError&&e.contractId===RESOLVER&&e.fn==="chain_policy"&&e.code===code&&e.codeName===codeName&&e.txHash===null);
  assert.equal(simulations,1);assert.equal(writes.length,0);
 });
test("unrelated contract reads do not acquire Resolver multichain error names",async()=>{
 const {s}=client();Object.assign(s,{read:(SoranHolder.prototype as any).read,server:{simulateTransaction:async()=>({error:"Error(Contract, #29)"})}});
 await assert.rejects((s as any).read(REGISTRY,"owner_of",[]),(e:unknown)=>e instanceof HolderError&&e.code===29&&e.codeName===null);
});
