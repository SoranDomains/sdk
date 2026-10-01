import assert from "node:assert/strict";
import test from "node:test";
import { Account, Address, Keypair, StrKey, hash, scValToNative, xdr, SorobanDataBuilder, TransactionBuilder } from "@stellar/stellar-sdk";
import { SoranHolder, DEPLOYMENTS } from "../src/index.js";
const kp=Keypair.random(),G=kp.publicKey(),RESOLVER=StrKey.encodeContract(new Uint8Array(32).fill(1)),REGISTRAR=StrKey.encodeContract(new Uint8Array(32).fill(2));
const REGISTRY=DEPLOYMENTS.testnet.registryId,nsNode=new Uint8Array(hash(Uint8Array.from([...new Uint8Array(32),...hash(new TextEncoder().encode("solo"))])));
function client(overrides:Record<string,unknown>={}){
 const s=new SoranHolder({signer:{publicKey:()=>G,signTransaction:async()=>{throw Error("unexpected signing");}}});const writes:any[]=[];
 Object.assign(s,{read:async(id:string,fn:string)=>{
  if(Object.hasOwn(overrides,fn))return overrides[fn];
  if(fn==="resolver_of")return RESOLVER;if(fn==="registrar_of")return REGISTRAR;if(fn==="owner_of")return G;
  if(fn==="anchors")return [REGISTRY,nsNode];if(fn==="subname_version")return 1;if(fn==="subname_policy")return ["Enabled"];if(fn==="registry")return REGISTRY;if(fn==="authority")return REGISTRAR;
  throw Error(`unexpected ${fn}`);
 },invoke:async(id:string,fn:string,args:any[])=>{writes.push({id,fn,args:args.map(scValToNative),types:args.map(v=>v.type)});return{hash:"hash",ledger:1};}});return{s,writes};
}
test("creation uses parent authority, exact generations and separate destination",async()=>{
 const {s,writes}=client();const destination=Keypair.random().publicKey();await s.createSubname("MAIL.FRED.SOLO",destination,{parentGeneration:9007199254740993n,previousGeneration:null});
 assert.deepEqual(writes[0].args,[new TextEncoder().encode("fred"),new TextEncoder().encode("mail"),9007199254740993n,null,destination]);assert.deepEqual(writes[0].types,["scvBytes","scvBytes","scvU64","scvVoid","scvAddress"]);
 await assert.rejects(s.createSubname("x.mail.fred.solo",G,{parentGeneration:0n,previousGeneration:null}));await assert.rejects(s.proposeNameTransfer("mail.fred.solo",G));await assert.rejects(s.setAddress("mail.fred.solo",G));
});
test("creation disabled and suspension block create but permit exact removal",async()=>{for(const policy of ["CreationDisabled","Suspended"]){const {s,writes}=client({subname_policy:[policy]});await assert.rejects(s.createSubname("mail.fred.solo",G,{parentGeneration:3n,previousGeneration:null}),/disabled/);assert.equal(writes.length,0);await s.removeSubname("mail.fred.solo",{parentGeneration:3n,generation:7n});assert.equal(writes[0].fn,"remove_subname");}});
test("listing page upkeep validates root names, u32 bounds and live Registrar context",async()=>{
 const {s,writes}=client({subname_policy:["Suspended"]});
 for(const page of [0,0xffff_ffff])await s.touchSubnamePage("FRED.SOLO",page);
 assert.deepEqual(writes.map(w=>({id:w.id,fn:w.fn,args:w.args,types:w.types})),[0,0xffff_ffff].map(page=>({id:REGISTRAR,fn:"touch_subname_page",args:[new TextEncoder().encode("fred"),page],types:["scvBytes","scvU32"]})));
 Object.assign(s,{read:async()=>{throw Error("unexpected read");}});
 for(const page of [-1,1.5,NaN,Infinity,0x1_0000_0000,"0",0n])await assert.rejects(s.touchSubnamePage("fred.solo",page as number),/u32 integer/);
 for(const name of ["mail.fred.solo","fred","fred..solo","K.solo"])await assert.rejects(s.touchSubnamePage(name,0),error=>!String(error).includes("unexpected read"));
 for(const overrides of [{anchors:[REGISTRY,new Uint8Array(32)]},{subname_version:2}]){
  const invalid=client(overrides);await assert.rejects(invalid.s.touchSubnamePage("fred.solo",0),/context mismatch|unsupported/);assert.equal(invalid.writes.length,0);
 }
});
for(const tamper of ["none","unexpected-auth","signer-body"] as const)test(`listing page upkeep pins its permissionless RPC intent: ${tamper}`,async()=>{
 const {s}=client();let signed=0,sent=0;
 Object.assign(s,{invoke:(SoranHolder.prototype as any).invoke,
  contractWallet:{address:RESOLVER,signAuthorization:async()=>{throw Error("permissionless upkeep must not request wallet authorization");}},
  signer:{publicKey:()=>G,signTransaction:async(raw:string,{networkPassphrase}:{networkPassphrase:string})=>{
   signed++;const original=TransactionBuilder.fromXDR(raw,networkPassphrase);
   const tx=tamper==="signer-body"?TransactionBuilder.cloneFrom(original as any,{networkPassphrase,fee:"999"}).build():original;tx.sign(kp);return tx.toXDR();
  }},server:{getAccount:async()=>new Account(G,"0"),simulateTransaction:async(tx:any)=>{
   const call=tx.operations[0].func.invokeContract;
   assert.equal(Address.fromScAddress(call.contractAddress).toString(),REGISTRAR);
   assert.equal(call.functionName.toString(),"touch_subname_page");
   assert.deepEqual(call.args.map(scValToNative),[new TextEncoder().encode("fred"),3]);
   const root=new xdr.SorobanAuthorizedInvocation({function:xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(call),subInvocations:[]});
   const auth=tamper==="unexpected-auth"?[new xdr.SorobanAuthorizationEntry({credentials:xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),rootInvocation:root})]:[];
   return {_parsed:true,transactionData:new SorobanDataBuilder(),minResourceFee:"0",result:{auth,retval:xdr.ScVal.scvVoid()},events:[],latestLedger:1};
  },sendTransaction:async(tx:any)=>{sent++;assert(kp.verify(tx.hash(),tx.signatures[0].signature));return {status:"PENDING"};}},confirm:async()=>({ledger:2,returnValue:null,events:[]})});
 if(tamper==="none"){assert.equal((await s.touchSubnamePage("fred.solo",3)).ledger,2);assert.equal(signed,1);assert.equal(sent,1);}
 else{await assert.rejects(s.touchSubnamePage("fred.solo",3),/must not require authorization|signer changed/);assert.equal(signed,tamper==="signer-body"?1:0);assert.equal(sent,0);}
});
for(const action of ["create", "remove"])for(const tamper of ["none","auth-args","auth-nested","signer-body"] as const)test(`subname ${action} signing validates exact intent: ${tamper}`,async()=>{
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
 const run=()=>action==="create"?s.createSubname("mail.fred.solo",G,{parentGeneration:3n,previousGeneration:null}):s.removeSubname("mail.fred.solo",{parentGeneration:3n,generation:7n});
 if(tamper==="none"){assert.equal((await run()).ledger,2);assert.equal(signed,1);assert.equal(sent,1);}
 else {await assert.rejects(run(),/differs from selected intent|signer changed/);assert.equal(signed,tamper==="signer-body"?1:0);assert.equal(sent,0);}
});

test("child record writes retain full name, recursive node and exact payment instructions",async()=>{
 const {s,writes}=client({payment_version:2,destination_version:2,chain_policy:[60],multichain_version:1});
 const destination=Keypair.random().publicKey();await s.setPayment("mail.fred.solo",{address:destination,memo:{type:"id",value:"9007199254740993"}});
 assert.deepEqual(writes[0].args,["mail.fred.solo",G,destination,["Id",9007199254740993n]]);
 await s.setText("mail.fred.solo","url","https://example.test");
 const {resolvableNameNode}=await import("../src/names.js");assert.deepEqual(writes[1].args[0],resolvableNameNode("mail.fred.solo"));
 await s.setChainAddress("mail.fred.solo","ethereum","0x52908400098527886E0F7030069857D2E4169EE7");assert.equal(writes[2].args[0],"mail.fred.solo");
});
