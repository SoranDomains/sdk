import assert from "node:assert/strict";
import test from "node:test";
import { Account, Address, Keypair, StrKey, hash, scValToNative, xdr, SorobanDataBuilder, TransactionBuilder } from "@stellar/stellar-sdk";
import { SoranOwner, DEPLOYMENTS } from "../src/index.js";
const kp=Keypair.random(),G=kp.publicKey(),RESOLVER=StrKey.encodeContract(new Uint8Array(32).fill(1)),REGISTRAR=StrKey.encodeContract(new Uint8Array(32).fill(2));
const REGISTRY=DEPLOYMENTS.testnet.registryId,nsNode=new Uint8Array(hash(Uint8Array.from([...new Uint8Array(32),...hash(new TextEncoder().encode("solo"))])));
function client(overrides:Record<string,unknown>={}){
 const s=new SoranOwner({signer:{publicKey:()=>G,signTransaction:async()=>{throw Error("unexpected signing");}}});const writes:any[]=[];
 Object.assign(s,{read:async(id:string,fn:string)=>{
  if(Object.hasOwn(overrides,fn))return overrides[fn];
  if(fn==="resolver_of")return RESOLVER;if(fn==="registrar_of")return REGISTRAR;if(fn==="owner_of")return G;
  if(fn==="anchors")return [REGISTRY,nsNode];if(fn==="subname_version")return 1;if(fn==="subname_policy")return ["Enabled"];if(fn==="registry")return REGISTRY;if(fn==="authority")return REGISTRAR;
  throw Error(`unexpected ${fn}`);
 },invoke:async(id:string,fn:string,args:any[])=>{writes.push({id,fn,args:args.map(scValToNative),types:args.map(v=>v.type)});return{hash:"hash",ledger:1};}});return{s,writes};
}
test("namespace policy uses live owner and exact enum",async()=>{const {s,writes}=client();assert.equal(await s.subnamePolicy("solo"),"enabled");await s.setSubnamePolicy("solo","creation-disabled");assert.deepEqual(writes[0].args,[["CreationDisabled"]]);assert.equal(writes[0].id,REGISTRAR);const bad=client({owner_of:Keypair.random().publicKey()});await assert.rejects(bad.s.setSubnamePolicy("solo","enabled"));assert.equal(bad.writes.length,0);});
for(const action of ["policy"])for(const tamper of ["none","auth-args","auth-nested","signer-body"] as const)test(`subname ${action} signing validates exact intent: ${tamper}`,async()=>{
 const {s}=client();let signed=0,sent=0;
 Object.assign(s,{invoke:(SoranOwner.prototype as any).invoke,signer:{publicKey:()=>G,signTransaction:async(raw:string,{networkPassphrase}:{networkPassphrase:string})=>{
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
 const run=()=>s.setSubnamePolicy("solo","enabled");
 if(tamper==="none"){assert.equal((await run()).ledger,2);assert.equal(signed,1);assert.equal(sent,1);}
 else {await assert.rejects(run(),/differs from selected intent|signer changed/);assert.equal(signed,tamper==="signer-body"?1:0);assert.equal(sent,0);}
});
