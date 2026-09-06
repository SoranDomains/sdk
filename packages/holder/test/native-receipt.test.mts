import assert from 'node:assert/strict';
import test from 'node:test';
import {Account,Contract,Keypair,Networks,StrKey,TransactionBuilder} from '@stellar/stellar-sdk';
import {validateNativeTerminalReceipt} from '../src/native-transport.js';
import {hex} from '../src/native-codec.js';
const account=Keypair.random(),contract=StrKey.encodeContract(new Uint8Array(32).fill(9));
const tx=new TransactionBuilder(new Account(account.publicKey(),'0'),{networkPassphrase:Networks.TESTNET,fee:'100'}).addOperation(new Contract(contract).call('keep_alive')).setTimeout(60).build();tx.sign(account);
const expected=hex(tx.hash());
for(const status of ['SUCCESS','FAILED']){
 test(`terminal ${status} is tied to original hash and confirmed ledger`,()=>{validateNativeTerminalReceipt({status,txHash:expected,ledger:42,envelopeXdr:tx.toEnvelope()} as any,expected,Networks.TESTNET);});
 for(const fault of ['wrong-hash','missing-hash','zero-ledger','fractional-ledger','large-ledger','missing-envelope','different-envelope','fee-bump-envelope'] as const)test(`terminal ${status} with ${fault} stays pending`,()=>{
  const receipt:any={status,txHash:expected,ledger:42,envelopeXdr:tx.toEnvelope()};
  if(fault==='wrong-hash')receipt.txHash='ff'.repeat(32);
  if(fault==='missing-hash')delete receipt.txHash;
  if(fault==='zero-ledger')receipt.ledger=0;
  if(fault==='fractional-ledger')receipt.ledger=1.5;
  if(fault==='large-ledger')receipt.ledger=4294967296;
  if(fault==='missing-envelope')delete receipt.envelopeXdr;
  if(fault==='different-envelope')receipt.envelopeXdr=TransactionBuilder.cloneFrom(tx,{networkPassphrase:Networks.TESTNET,fee:'200'}).build().toEnvelope();
  if(fault==='fee-bump-envelope')receipt.envelopeXdr=TransactionBuilder.buildFeeBumpTransaction(account,'200',tx,Networks.TESTNET).toEnvelope();
  assert.throws(()=>validateNativeTerminalReceipt(receipt,expected,Networks.TESTNET),(e:any)=>e.kind==='pending'&&e.txHash===expected);
 });
}
