import assert from 'node:assert/strict';
import test from 'node:test';
import { Address, Keypair, Networks, StrKey, buildAuthorizationEntryPreimage, hash, xdr } from '@stellar/stellar-sdk';
import { signContractAuthorization } from '../src/contract-wallet.js';
import { authorizedInvocation } from '../src/native-auth.js';
import { sc } from '../src/native-codec.js';
const C=(n:number)=>StrKey.encodeContract(new Uint8Array(32).fill(n));
const key=Keypair.random(), account=C(1), target=C(2);
const expected={account,latestLedger:100,maxExpirationLedger:150};
function entry(){return new xdr.SorobanAuthorizationEntry({credentials:xdr.SorobanCredentials.sorobanCredentialsAddress(new xdr.SorobanAddressCredentials({address:new Address(account).toScAddress(),nonce:72n,signatureExpirationLedger:0,signature:xdr.ScVal.scvVoid()})),rootInvocation:authorizedInvocation({contract:target,method:'set_reverse',args:[sc.address(account),xdr.ScVal.scvString('alice.nova')]})});}
for(const format of ['bytes','map','void'] as const)test(`contract wallet receives the precise signing payload and returns ${format}`,async()=>{
 const original=entry(),before=original.toXDR('base64');
 const result=await signContractAuthorization(original,expected,{address:account,signAuthorization:async request=>{
  assert.equal(request.address,account);assert.equal(request.networkPassphrase,Networks.TESTNET);
  assert.deepEqual(request.signaturePayload,hash(buildAuthorizationEntryPreimage(original,150,Networks.TESTNET).toXDR()));
  const reviewed=xdr.SorobanAuthorizationEntry.fromXDR(request.authorizationEntryXdr,'base64');
  assert.equal(reviewed.credentials.type,'sorobanCredentialsAddress');
  if(reviewed.credentials.type==='sorobanCredentialsAddress')assert.equal(reviewed.credentials.address.signatureExpirationLedger,150);
  if(format==='bytes')return sc.bytes(key.sign(request.signaturePayload));
  if(format==='void')return xdr.ScVal.scvVoid();
  return xdr.ScVal.scvMap([new xdr.ScMapEntry({key:sc.symbol('signature'),val:sc.bytes(key.sign(request.signaturePayload))})]);
 }},Networks.TESTNET);
 assert.equal(original.toXDR('base64'),before);
 assert.equal(result.rootInvocation.toXDR('base64'),original.rootInvocation.toXDR('base64'));
 assert.equal(result.credentials.type,'sorobanCredentialsAddress');
 if(result.credentials.type==='sorobanCredentialsAddress'){assert.equal(result.credentials.address.nonce,72n);assert.equal(result.credentials.address.signatureExpirationLedger,150);}
});
for(const attack of ['wrong-account','wrong-wallet','invalid-window','oversized'] as const)test(`contract authorizer rejects ${attack}`,async()=>{
 await assert.rejects(signContractAuthorization(entry(),{...expected,...(attack==='wrong-account'?{account:C(3)}:attack==='invalid-window'?{latestLedger:150}:{})},{address:attack==='wrong-wallet'?C(4):account,signAuthorization:async()=>sc.bytes(new Uint8Array(attack==='oversized'?17000:64))},Networks.TESTNET));
});

import { Account, SorobanDataBuilder, TransactionBuilder } from '@stellar/stellar-sdk';
import { SoranHolder } from '../src/index.js';
for(const method of ['setPayment','setRecord','setText','setReverse','clearReverse','setPrimary','clearPrimary','proposeNameTransfer','acceptNameTransfer','cancelNameTransfer'] as const)test(`C holder ${method} keeps the G payer separate and enforces custom auth`,async()=>{
 let authorizations=0,payerSignatures=0,enforces=0,sent:any;
 const registry=C(3),resolver=C(4),registrar=C(5),primary=C(6);
 const holder=new SoranHolder({registryId:registry,primaryId:primary,signer:{publicKey:()=>key.publicKey(),signTransaction:async(encoded,opts)=>{payerSignatures++;assert.equal(enforces,1);const tx=TransactionBuilder.fromXDR(encoded,opts.networkPassphrase);tx.sign(key);return tx.toXDR();}},contractWallet:{address:account,signAuthorization:async({signaturePayload})=>{authorizations++;return sc.bytes(key.sign(signaturePayload));}}});
 Object.assign(holder,{paymentResolverOf:async()=>({resolver,version:2}),resolverOf:async()=>resolver,registrarOf:async()=>registrar,read:async()=>registry,server:{
  getLatestLedger:async()=>({sequence:100}),getAccount:async(address:string)=>{assert.equal(address,key.publicKey());return new Account(address,'0');},
  simulateTransaction:async(tx:any,_resources:any,mode:any)=>{const call=tx.operations[0].func.invokeContract;if(mode==='enforce'){enforces++;assert.equal(authorizations,1);}return {_parsed:true,latestLedger:100,transactionData:new SorobanDataBuilder(),minResourceFee:'0',events:[],result:{retval:xdr.ScVal.scvVoid(),auth:[new xdr.SorobanAuthorizationEntry({credentials:xdr.SorobanCredentials.sorobanCredentialsAddress(new xdr.SorobanAddressCredentials({address:new Address(account).toScAddress(),nonce:99n,signatureExpirationLedger:0,signature:xdr.ScVal.scvVoid()})),rootInvocation:authorizedInvocation({contract:Address.fromScAddress(call.contractAddress).toString(),method:call.functionName.toString(),args:call.args})})]}};},
  sendTransaction:async(tx:any)=>{sent=tx;assert.equal(tx.source,key.publicKey());return{status:'PENDING',hash:Buffer.from(tx.hash()).toString('hex')};},
  getTransaction:async()=>({status:'SUCCESS',txHash:Buffer.from(sent.hash()).toString('hex'),envelopeXdr:sent.toEnvelope(),ledger:101,returnValue:xdr.ScVal.scvVoid()}),
 }});
 if(method==='setPayment')await holder.setPayment('alice.nova',{address:account,memo:{type:'none'}});
 else if(method==='setRecord')await holder.setRecord('alice.nova',account);
 else if(method==='setText')await holder.setText('alice.nova','url','https://example.com');
 else if(method==='clearReverse')await holder.clearReverse('nova');
 else if(method==='clearPrimary')await holder.clearPrimary();
 else if(method==='proposeNameTransfer')await holder.proposeNameTransfer('alice.nova',C(7));
 else await holder[method]('alice.nova');
 assert.equal(authorizations,1);assert.equal(payerSignatures,1);assert.equal(enforces,1);
 const call=sent.operations[0].func.invokeContract;
 assert(!call.args.some((arg:xdr.ScVal)=>arg.type==='scvAddress'&&Address.fromScAddress(arg.address).toString()===key.publicKey()));
});
