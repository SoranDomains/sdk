import assert from "node:assert/strict";
import test from "node:test";
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import { Soran, SoranError, encodeMuxedAddress, type PaymentDestination } from "@sorandomains/lookup";
import { SoranHolder } from "@sorandomains/holder";
import { registerReadTools, registerWriteTools } from "../src/tools.js";
const kp=Keypair.random(),G=kp.publicKey(),C=StrKey.encodeContract(new Uint8Array(32).fill(8));
const matrix:Array<[string,PaymentDestination]>=[
 ["G-none",{address:G,memo:{type:"none"}}],["G-ID",{address:G,memo:{type:"id",value:"18446744073709551615"}}],
 ["G-text",{address:G,memo:{type:"text",value:"customer-420"}}],["G-hash",{address:G,memo:{type:"hash",value:"ab".repeat(32)}}],
 ["C-none",{address:C,memo:{type:"none"}}],...["0","9007199254740993","18446744073709551615"].map((id):[string,PaymentDestination]=>["M-"+id,{address:encodeMuxedAddress(G,id),memo:{type:"none"}}]),
];
function fake(){const handlers=new Map<string,(a:any)=>Promise<any>>(),schemas=new Map<string,any>();return {handlers,schemas,server:{tool(name:string,_description:string,schema:any,handler:any){handlers.set(name,handler);schemas.set(name,schema);}}};}
for(const [label,payment] of matrix)test(`MCP full read/write/schema matrix: ${label}`,async()=>{
 const saved={resolve:Soran.prototype.resolvePayment,verify:Soran.prototype.verifyPayment,lookup:Soran.prototype.lookup,record:Soran.prototype.record,assurance:Soran.prototype.assurance,set:SoranHolder.prototype.setPayment};
 try{
  Soran.prototype.resolvePayment=async()=>payment;
  Soran.prototype.verifyPayment=async(_name,value)=>{assert.deepEqual(value,payment);return true;};
  Soran.prototype.lookup=async()=>({kind:"nativePayment",name:"alice.nova",registrar:C,resolver:C,generation:1n,payment});
  Soran.prototype.record=async()=>{if(payment.memo.type!=="none")throw new SoranError("memo required","PAYMENT_REQUIRED");return {name:"alice.nova",address:payment.address,node:"00".repeat(32),resolver:C};};
  Soran.prototype.assurance=async()=>({trustworthy:false} as any);
  SoranHolder.prototype.setPayment=async(_name,value)=>{assert.deepEqual(value,payment);return {hash:"h",ledger:1};};
  const f=fake();registerReadTools(f.server as never);await registerWriteTools(f.server as never,{secret:kp.secret()});
  assert.deepEqual(f.schemas.get("set_payment").payment.parse(payment),payment);
  assert.deepEqual(f.schemas.get("verify_payment").payment.parse(payment),payment);
  const resolved=JSON.parse((await f.handlers.get("resolve_payment")!({name:"alice.nova"})).content[0].text);
  assert.equal(resolved.address,payment.address);assert.deepEqual(resolved.memo,payment.memo);
  assert.deepEqual(JSON.parse((await f.handlers.get("lookup_name")!({name:"alice.nova"})).content[0].text).payment,payment);
  assert.equal(JSON.parse((await f.handlers.get("verify_payment")!({name:"alice.nova",payment})).content[0].text).verified,true);
  assert.equal(JSON.parse((await f.handlers.get("set_payment")!({name:"alice.nova",payment})).content[0].text).hash,"h");
  const addressResult=await f.handlers.get("resolve_name")!({name:"alice.nova"});
  if(payment.memo.type==="none")assert.equal(JSON.parse(addressResult.content[0].text).address,payment.address);else assert.equal(addressResult.isError,true);
 }finally{Soran.prototype.resolvePayment=saved.resolve;Soran.prototype.verifyPayment=saved.verify;Soran.prototype.lookup=saved.lookup;Soran.prototype.record=saved.record;Soran.prototype.assurance=saved.assurance;SoranHolder.prototype.setPayment=saved.set;}
});
test("MCP schema rejects separate muxed memos, bad checksums and C memos before writes",async()=>{
 const f=fake();registerReadTools(f.server as never);await registerWriteTools(f.server as never,{secret:kp.secret()});const M=encodeMuxedAddress(G,"420");
 for(const payment of [{address:M,memo:{type:"id",value:"420"}},{address:M,memo:{type:"text",value:"hi"}},{address:M,memo:{type:"hash",value:"ab".repeat(32)}},{address:M.slice(0,-1)+(M.endsWith("A")?"B":"A"),memo:{type:"none"}},{address:C,memo:{type:"id",value:"1"}},{address:G,memo:{type:"id",value:"-1"}},{address:G,memo:{type:"id",value:"18446744073709551616"}}])for(const tool of ["set_payment","verify_payment"])assert.throws(()=>f.schemas.get(tool).payment.parse(payment));
});
test("MCP surfaces a v1 muxed failure, without an address-shaped result",async()=>{
 const saved=Soran.prototype.resolvePayment;
 try{Soran.prototype.resolvePayment=async()=>{throw new SoranError("muxed requires v2","SIMULATION",22,"MuxedDestination");};const f=fake();registerReadTools(f.server as never);const result=await f.handlers.get("resolve_payment")!({name:"alice.nova"});assert.equal(result.isError,true);const value=JSON.parse(result.content[0].text);assert.equal(value.contractError,"MuxedDestination");assert(!Object.hasOwn(value,"address"));}finally{Soran.prototype.resolvePayment=saved;}
});
