import assert from "node:assert/strict";
import test from "node:test";
import { Account, Address, Keypair, Networks, Operation, SorobanDataBuilder, StrKey, TransactionBuilder, nativeToScVal, scValToNative, xdr } from "@stellar/stellar-sdk";
import { SoranHolder, HolderError, DEPLOYMENTS, encodeMuxedAddress, decodeMuxedAddress, type PaymentDestination } from "../src/index.js";
import { paymentMemoToScVal, encodePaymentRecord, parsePaymentRecord } from "../src/payment.js";
const kp=Keypair.random(),G=kp.publicKey(),OTHER=Keypair.random().publicKey();
const C=StrKey.encodeContract(new Uint8Array(32).fill(7)),REGISTRAR=StrKey.encodeContract(new Uint8Array(32).fill(8));
const REGISTRY=DEPLOYMENTS.testnet.registryId;
const signer={publicKey:()=>G,signTransaction:async()=>{throw new Error("must not sign");}};
const matrix:Array<[string,PaymentDestination]>=[
 ["G-none",{address:G,memo:{type:"none"}}],["G-ID",{address:G,memo:{type:"id",value:"18446744073709551615"}}],
 ["G-text",{address:G,memo:{type:"text",value:"customer-420"}}],["G-hash",{address:G,memo:{type:"hash",value:"ab".repeat(32)}}],
 ["C-none",{address:C,memo:{type:"none"}}],...["0","9007199254740993","18446744073709551615"].map((id):[string,PaymentDestination]=>["M-"+id,{address:encodeMuxedAddress(G,id),memo:{type:"none"}}]),
];
const readNative=(overrides:Record<string,unknown>={})=>async(id:string,fn:string,args:xdr.ScVal[])=>{
 if(Object.hasOwn(overrides,fn)){const v=overrides[fn];if(v instanceof Error)throw v;return v;}
 if(fn==="resolver_of")return C;if(fn==="registrar_of")return REGISTRAR;
 if(fn==="anchors"){assert.equal(id,REGISTRAR);return [REGISTRY,scValToNative(lastNamespaceArg!)];}
 if(fn==="registry")return REGISTRY;if(fn==="authority")return REGISTRAR;
 if(fn==="payment_version"||fn==="destination_version")return 2;
 if(fn==="resolve_destination")return ["Direct",{address:G,memo:["None"]}];
 throw new Error("unexpected "+fn);
};
let lastNamespaceArg:xdr.ScVal|undefined;
function wireRead(s:SoranHolder,overrides:Record<string,unknown>={}){
 const read=readNative(overrides);
 Object.assign(s,{read:async(id:string,fn:string,args:xdr.ScVal[])=>{if(fn==="resolver_of")lastNamespaceArg=args[0];return read(id,fn,args);}});
}
for(const [label,payment] of matrix)test(`setPayment v2 matrix preserves exact fields: ${label}`,async()=>{
 const s=new SoranHolder({signer});wireRead(s);let count=0;
 Object.assign(s,{invoke:async(id:string,fn:string,args:xdr.ScVal[],errors:Record<number,string>)=>{
  count++;assert.equal(id,C);assert.equal(errors[21],"MuxedDestination");
  const decoded=args.map(a=>scValToNative(a));assert.deepEqual(decoded.slice(0,2),["alice.nova",G]);
  if(payment.address[0]==="M"){
   const m=decodeMuxedAddress(payment.address);assert.equal(fn,"set_muxed");assert.deepEqual(decoded.slice(2),[m.account,BigInt(m.id)]);
  }else{assert.equal(fn,"set_payment");assert.equal(decoded[2],payment.address);assert.deepEqual(decoded[3],scValToNative(paymentMemoToScVal(payment.memo)));}
  return {hash:"h",ledger:1};
 }});
 assert.deepEqual(await s.setPayment("ALICE.NOVA",payment),{hash:"h",ledger:1});assert.equal(count,1);
 assert.deepEqual(parsePaymentRecord(encodePaymentRecord(payment)),payment);
});
test("missing v2 support and malformed inputs never invoke or strip the muxed ID",async()=>{
 const M=encodeMuxedAddress(G,"420");
 for(const overrides of [{payment_version:1},{payment_version:3},{payment_version:2n},{payment_version:new Error("offline")},{destination_version:1},{destination_version:new Error("missing method")}]){
  const s=new SoranHolder({signer});wireRead(s,overrides);Object.assign(s,{invoke:async()=>assert.fail("must not invoke")});
  await assert.rejects(s.setPayment("alice.nova",{address:M,memo:{type:"none"}}));
 }
 const s=new SoranHolder({signer});Object.assign(s,{read:async()=>assert.fail("must reject before read")});
 for(const payment of [{address:M,memo:{type:"id",value:"420"}},{address:M.slice(0,-1)+(M.endsWith("A")?"B":"A"),memo:{type:"none"}},{address:C,memo:{type:"id",value:"1"}}])await assert.rejects(s.setPayment("alice.nova",payment as PaymentDestination));
});
test("account-only setters refuse implicit muxed rewrites",async()=>{
 const M=encodeMuxedAddress(G,"420"),s=new SoranHolder({signer});wireRead(s,{resolve_destination:["Muxed",{account:G,id:420n}]});
 Object.assign(s,{invoke:async()=>assert.fail("must not rewrite")});
 await assert.rejects(s.setAddress("alice.nova",G),/muxed routing ID/);
 await assert.rejects(s.setRecord("alice.nova",M),/setPayment/);
});
function invokeArgs(payment:PaymentDestination){return payment.address[0]==="M"?[nativeToScVal("alice.nova",{type:"string"}),new Address(G).toScVal(),new Address(decodeMuxedAddress(payment.address).account).toScVal(),nativeToScVal(BigInt(decodeMuxedAddress(payment.address).id),{type:"u64"})]:[nativeToScVal("alice.nova",{type:"string"}),new Address(G).toScVal(),new Address(payment.address).toScVal(),paymentMemoToScVal(payment.memo)];}
function auth(fn:string,args:xdr.ScVal[],nested=false){
 const call=new xdr.InvokeContractArgs({contractAddress:new Address(C).toScAddress(),functionName:fn,args});
 const root=new xdr.SorobanAuthorizedInvocation({function:xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(call),subInvocations:[]});
 if(nested)root.subInvocations=[new xdr.SorobanAuthorizedInvocation({function:xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(call),subInvocations:[]})];
 return new xdr.SorobanAuthorizationEntry({credentials:xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),rootInvocation:root});
}
for(const [label,payment] of matrix)for(const format of ["string","object"] as const)test(`actual wallet signing/transaction pipeline ${format}: ${label}`,async()=>{
 let signatures=0,submitted=0;const expectedFn=payment.address[0]==="M"?"set_muxed":"set_payment";
 const expected=invokeArgs(payment);
 const s=new SoranHolder({signer:{publicKey:()=>G,signTransaction:async(encoded,{networkPassphrase})=>{
  signatures++;assert.equal(networkPassphrase,Networks.TESTNET);const tx=TransactionBuilder.fromXDR(encoded,networkPassphrase);
  const op=tx.operations[0] as any;assert.equal(op.func.invokeContract.functionName.toString(),expectedFn);
  assert.deepEqual(op.func.invokeContract.args.map((v:xdr.ScVal)=>v.toXDR("base64")),expected.map(v=>v.toXDR("base64")));
  tx.sign(kp);return format==="string"?tx.toXDR():{signedTxXdr:tx.toXDR()};
 }}});wireRead(s);
 Object.assign(s,{server:{getAccount:async()=>new Account(G,"0"),simulateTransaction:async()=>({_parsed:true,transactionData:new SorobanDataBuilder(),minResourceFee:"0",result:{auth:[auth(expectedFn,expected)],retval:xdr.ScVal.scvVoid()},events:[],latestLedger:1}),sendTransaction:async(tx:any)=>{submitted++;assert.equal(tx.signatures.length,1);assert(kp.verify(tx.hash(),tx.signatures[0].signature));return {status:"PENDING"};}},confirm:async()=>({ledger:2,returnValue:null})});
 assert.equal((await s.setPayment("alice.nova",payment)).ledger,2);assert.equal(signatures,1);assert.equal(submitted,1);
});
for(const tamper of ["auth-base","auth-id","auth-nested","signer-base","signer-id"] as const)test(`muxed signing guard rejects ${tamper}`,async()=>{
 const payment={address:encodeMuxedAddress(G,"18446744073709551615"),memo:{type:"none"}} as PaymentDestination;
 const args=invokeArgs(payment),bad=[...args];bad[tamper.endsWith("base")?2:3]=tamper.endsWith("base")?new Address(OTHER).toScVal():nativeToScVal(0n,{type:"u64"});
 let signatures=0,submitted=0;
 const s=new SoranHolder({signer:{publicKey:()=>G,signTransaction:async(encoded,{networkPassphrase})=>{
  signatures++;const original=TransactionBuilder.fromXDR(encoded,networkPassphrase);
  const tx=TransactionBuilder.cloneFrom(original as any,{networkPassphrase}).clearOperations().addOperation(Operation.invokeContractFunction({contract:C,function:"set_muxed",args:bad,auth:[auth("set_muxed",bad)]})).build();tx.sign(kp);return tx.toXDR();
 }}});wireRead(s);
 Object.assign(s,{server:{getAccount:async()=>new Account(G,"0"),simulateTransaction:async()=>({_parsed:true,transactionData:new SorobanDataBuilder(),minResourceFee:"0",result:{auth:[auth("set_muxed",tamper.startsWith("auth-")&&tamper!=="auth-nested"?bad:args,tamper==="auth-nested")],retval:xdr.ScVal.scvVoid()},events:[],latestLedger:1}),sendTransaction:async()=>{submitted++;throw new Error("must not submit");}}});
 await assert.rejects(s.setPayment("alice.nova",payment),/differs from selected intent|signer changed/);
 assert.equal(signatures,tamper.startsWith("auth-")?0:1);assert.equal(submitted,0);
});
