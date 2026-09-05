import assert from "node:assert/strict";
import test from "node:test";
import { Account, Address, Asset, MuxedAccount, Networks, Operation, StrKey, TransactionBuilder, nativeToScVal, scValToNative, xdr } from "@stellar/stellar-sdk";
import { Soran, SoranError, DEPLOYMENTS, encodeMuxedAddress, decodeMuxedAddress, type PaymentDestination } from "../src/index.js";
import { destinationFromNative, paymentFromNative, paymentMemoToScVal, encodePaymentRecord, parsePaymentRecord, validatePaymentDestination } from "../src/payment.js";
const G="GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ";
const C=StrKey.encodeContract(new Uint8Array(32).fill(7));
const REGISTRAR=StrKey.encodeContract(new Uint8Array(32).fill(8));
const RESOLVER=StrKey.encodeContract(new Uint8Array(32).fill(9));
const LOOKUP=StrKey.encodeContract(new Uint8Array(32).fill(10));
const registry=DEPLOYMENTS.testnet.registryId;
const matrix: Array<[string, PaymentDestination]> = [
  ["G-none",{address:G,memo:{type:"none"}}], ["G-ID0",{address:G,memo:{type:"id",value:"0"}}],
  ["G-IDmax",{address:G,memo:{type:"id",value:"18446744073709551615"}}],
  ["G-text",{address:G,memo:{type:"text",value:"customer-420"}}],
  ["G-hash",{address:G,memo:{type:"hash",value:"ab".repeat(32)}}], ["C-none",{address:C,memo:{type:"none"}}],
  ...["0","9007199254740993","18446744073709551615"].map((id):[string,PaymentDestination]=>["M-"+id,{address:encodeMuxedAddress(G,id),memo:{type:"none"}}]),
];
const direct=(p:PaymentDestination)=>({address:p.address,memo:scValToNative(paymentMemoToScVal(p.memo))});
const native=(p:PaymentDestination):unknown[]=>{
 if(p.address[0]==="M"){const m=decodeMuxedAddress(p.address);return ["Muxed",{account:m.account,id:BigInt(m.id)}];}
 return ["Direct",direct(p)];
};
const nsNode=await new Soran().namehash("nova");
function client(mode:"universal"|"direct",p:PaymentDestination,overrides:Record<string,unknown>={}){
 const s=new Soran({resolutionMode:mode,...(mode==="universal"?{lookupId:LOOKUP}:{})});
 const calls:string[]=[];
 Object.assign(s,{read:async(id:string,fn:string)=>{
  calls.push(fn);
  if(Object.hasOwn(overrides,fn)){const v=overrides[fn];if(v instanceof Error)throw v;return v;}
  if(fn==="registry")return registry;
  if(fn==="version"||fn==="payment_version"||fn==="destination_version")return 2;
  if(mode==="universal"){
   assert.equal(id,LOOKUP);assert.equal(fn,"resolve_v2");
   return {name:"alice.nova",registrar:REGISTRAR,resolver:RESOLVER,generation:42n,result:["NativePayment",native(p)]};
  }
  if(fn==="resolver_of")return RESOLVER;
  if(fn==="registrar_of")return REGISTRAR;
  if(fn==="authority")return REGISTRAR;
  if(fn==="anchors")return [registry,nsNode];
  assert.equal(id,RESOLVER);assert.equal(fn,"resolve_destination");return native(p);
 }});
 return {s,calls};
}
for(const [label,p] of matrix){
 test(`destination codec and real XDR: ${label}`,()=>{
  assert.deepEqual(validatePaymentDestination(p),p);
  assert.deepEqual(destinationFromNative(native(p)),p);
  assert.deepEqual(parsePaymentRecord(encodePaymentRecord(p)),p);
  if(p.address[0]==="M"){
   const m=decodeMuxedAddress(p.address);
   assert.equal(new MuxedAccount(new Account(m.account,"0"),m.id).accountId(),p.address);
   const map=xdr.ScVal.scvMap([
    new xdr.ScMapEntry({key:nativeToScVal("account",{type:"symbol"}),val:new Address(m.account).toScVal()}),
    new xdr.ScMapEntry({key:nativeToScVal("id",{type:"symbol"}),val:nativeToScVal(BigInt(m.id),{type:"u64"})}),
   ]);
   assert.deepEqual(destinationFromNative(scValToNative(xdr.ScVal.scvVec([nativeToScVal("Muxed",{type:"symbol"}),map]))),p);
   assert.throws(()=>paymentFromNative({address:p.address,memo:["None"]}));
   assert.throws(()=>parsePaymentRecord(`1|${p.address}|none|`));
  }
 });
 for(const mode of ["universal","direct"] as const)test(`${mode} V2 full forward/verification matrix: ${label}`,async()=>{
  const {s}=client(mode,p);
  assert.deepEqual(await s.resolvePayment("ALICE.NOVA"),p);
  assert.equal(await s.verifyPayment("alice.nova",p),true);
  if(mode==="universal"){
   const found=await s.lookup("alice.nova");assert.equal(found.kind,"nativePayment");
   if(found.kind==="nativePayment")assert.deepEqual(found.payment,p);
  }
  if(p.memo.type==="none"){
   assert.equal(await s.resolve("alice.nova"),p.address);
   assert.equal((await s.record("alice.nova")).address,p.address);
   assert.equal(await s.verify("alice.nova",p.address),true);
   if(p.address[0]==="M"){
    assert.equal(await s.verify("alice.nova",G),false);
    assert.equal(await s.verifyPayment("alice.nova",{address:G,memo:{type:"none"}}),false);
    assert.equal(await s.verifyPayment("alice.nova",{address:G,memo:{type:"id",value:decodeMuxedAddress(p.address).id}}),false);
    const other=encodeMuxedAddress(G,decodeMuxedAddress(p.address).id==="0"?"1":"0");
    assert.equal(await s.verifyPayment("alice.nova",{address:other,memo:{type:"none"}}),false);
   }
  }else await assert.rejects(s.resolve("alice.nova"),(e:unknown)=>e instanceof SoranError&&e.code==="PAYMENT_REQUIRED");
 });
}
test("muxed values reject invalid checksums, noncanonical fields and separate memos",()=>{
 const M=encodeMuxedAddress(G,"420");
 assert.equal(M,"MA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJUAAAAAAAAAABUTGI4");
 for(const address of [M.toLowerCase(),M.slice(0,-1)+"A",M+" ","M",G])assert.throws(()=>decodeMuxedAddress(address));
 for(const id of ["-1","18446744073709551616","0420","",420,420n])assert.throws(()=>encodeMuxedAddress(G,id as string));
 for(const account of [C,M,"Gbad"])assert.throws(()=>encodeMuxedAddress(account,"0"));
 for(const memo of [{type:"id",value:"420"},{type:"text",value:"hi"},{type:"hash",value:"ab".repeat(32)}])assert.throws(()=>validatePaymentDestination({address:M,memo}));
 for(const raw of [["Muxed",{account:G,id:0}],["Muxed",{account:G,id:"0"}],["Muxed",{account:G,id:-1n}],["Muxed",{account:G,id:1n<<64n}],["Muxed",{account:C,id:0n}],["Muxed",{account:M,id:0n}],["Muxed",{account:G,id:0n,extra:true}],["Muxed",{account:G,id:0n},true],["Other",{}],["Direct",{address:M,memo:["None"]}]])assert.throws(()=>destinationFromNative(raw));
});
for(const mode of ["universal","direct"] as const)test(`${mode} v2 capability/read failures never downgrade`,async()=>{
 const p=matrix.at(-1)![1];
 for(const fn of [mode==="universal"?"version":"payment_version","destination_version",mode==="universal"?"resolve_v2":"resolve_destination"]){
  for(const code of ["RPC","ARCHIVED","SIMULATION","TIMEOUT","ABI"] as const){
   const failure=new SoranError("unreadable "+fn,code);const {s,calls}=client(mode,p,{[fn]:failure});
   for(const run of [()=>s.resolvePayment("alice.nova"),()=>s.record("alice.nova"),()=>s.verifyPayment("alice.nova",p)])await assert.rejects(run(),e=>e===failure);
   assert(!calls.some(fn=>["resolve","resolve_payment","addr","text"].includes(fn)));
  }
 }
 for(const version of [1,2n,"2",0,3,null]){
  const {s,calls}=client(mode,p,{destination_version:version});
  await assert.rejects(s.resolvePayment("alice.nova"));
  assert(!calls.some(fn=>["resolve","resolve_payment","resolve_v2","resolve_destination"].includes(fn)));
 }
});
test("successful v1 capability remains compatible; old methods' muxed errors never return the base",async()=>{
 for(const mode of ["universal","direct"] as const){
  const {s,calls}=client(mode,matrix[0][1],{version:1,payment_version:1,resolve:{name:"alice.nova",registrar:REGISTRAR,resolver:RESOLVER,generation:42n,result:["NativePayment",direct(matrix[0][1])]},resolve_payment:direct(matrix[0][1])});
  assert.deepEqual(await s.resolvePayment("alice.nova"),matrix[0][1]);assert(!calls.includes("destination_version"));
  const failure=new SoranError("MuxedDestination","SIMULATION",mode==="universal"?22:21,"MuxedDestination");
  const rejected=client(mode,matrix.at(-1)![1],{version:1,payment_version:1,resolve:failure,resolve_payment:failure});
  await assert.rejects(rejected.s.resolvePayment("alice.nova"),e=>e===failure);
 }
});
test("muxed payment survives an actual Stellar payment operation without becoming a memo",()=>{
 const M=encodeMuxedAddress(G,"18446744073709551615");
 const tx=new TransactionBuilder(new Account(G,"0"),{fee:"100",networkPassphrase:Networks.TESTNET})
  .addOperation(Operation.payment({destination:M,asset:Asset.native(),amount:"1"})).setTimeout(30).build();
 const decoded=TransactionBuilder.fromXDR(tx.toXDR(),Networks.TESTNET);
 assert.equal(decoded.memo.type,"none");assert.equal((decoded.operations[0] as {destination:string}).destination,M);
});
test("muxed destination never becomes an account-level reverse or holdings input",async()=>{
 const {s,calls}=client("universal",matrix.at(-1)![1]);const M=matrix.at(-1)![1].address;
 await assert.rejects(s.reverse("nova",M));assert.equal(await s.primaryOf(M),null);await assert.rejects(s.namesOfPage(M));assert.equal(calls.length,0);
});

for(const mode of ["universal","direct"] as const)test(`${mode} details/identity keep muxed destination separate from holder metadata`,async()=>{
 const p=matrix.at(-1)![1],{s}=client(mode,p);
 Object.assign(s,{
  nameMetadata:async()=>({name:"alice.nova",node:"00".repeat(32),registrar:REGISTRAR,holder:G,builtinAddress:G,generation:42n,expiresAt:0n,active:true,noExpiry:true,namespacePermanent:false}),
  namespaceMetadata:async()=>({namespace:"nova",node:"00".repeat(32),owner:G,registrar:REGISTRAR,resolver:RESOLVER,resolverAttested:false,resolverLocked:false,resolverTainted:false,registrarTainted:false,permanent:false,policy:null}),
  attestedRegistrarOf:async()=>null,namespace:async()=>null,assurance:async()=>({trustworthy:false,resolverAttested:false,resolverTainted:false,resolverLocked:false}),profile:async()=>({}),
 });
 const details=await s.details("alice.nova");assert.equal(details.address,p.address);assert.deepEqual(details.payment,p);assert.equal(details.paymentRequired,false);
 assert.deepEqual((await s.identity("alice.nova")).details.payment,p);
});
