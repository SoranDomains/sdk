import test from 'node:test';
import assert from 'node:assert/strict';
import { Address, Contract, StrKey, scValToNative, xdr } from '@stellar/stellar-sdk';
import { expectedRegistrarCode } from '../src/native-code-policy.js';
import { verifyRegistrarProvenance } from '../src/native-transport.js';
import { instanceProof } from './helpers/native-ledger.mjs';
const C=(n:number)=>StrKey.encodeContract(new Uint8Array(32).fill(n));
const G=StrKey.encodeEd25519PublicKey(new Uint8Array(32).fill(8));
const registry=C(1),registrar=C(2),namespace='aa'.repeat(32), old=new Uint8Array(32).fill(1),current=new Uint8Array(32).fill(2);
function fixture(governed=true) {
 const proof=instanceProof(registry,200), data=proof.entries[0].val.value.val.value;
 data.storage=governed?[new xdr.ScMapEntry({key:xdr.ScVal.scvVec([xdr.ScVal.scvSymbol('AuthorityV1')]),val:new Address(G).toScVal()})]:[];
 let value:any={registrar:current,resolver:old,registrar_updates:2,resolver_updates:1}; let version=1;let observation=200;
 const calls:string[]=[];
 const read=async(_id:string,method:string,args:xdr.ScVal[])=>{
   calls.push(method);
   if(method==='upgrade_policy_version')return version;
   if(method==='native_code'){assert.equal(Buffer.from(scValToNative(args[0])).toString('hex'),namespace);return value;}
   if(method==='template_hashes')return [old,old];
   if(method==='registrar_of')return registrar;
   if(method==='registrar_tainted')return false;
   throw Error('unexpected '+method);
 };
 const context:any={registryId:registry,server:{getLedgerEntries:async(key:xdr.LedgerKey)=>{assert.equal(key.toXDR('base64'),new Contract(registry).getFootprint().toXDR('base64'));return proof;},getContractInstance:async()=>({executable:{type:'contractExecutableWasm',wasmHash:{value:current}}})},read,readWithLedger:async(...args:any[])=>({value:await read(...args as [string,string,xdr.ScVal[]]),ledger:observation})};
 return{context,proof,calls,setCode:(v:any)=>{value=v;},setVersion:(v:number)=>{version=v;},setLedger:(v:number)=>{observation=v;},data};
}
test('reviewed per-namespace code overrides factory defaults after repeated upgrades',async()=>{
 const f=fixture();assert.equal(await expectedRegistrarCode(f.context,namespace),'02'.repeat(32));
 await verifyRegistrarProvenance(f.context,registrar,namespace);
 assert(!f.calls.includes('template_hashes'));
});
test('historical instance without authority still requires its exact template',async()=>{
 const f=fixture(false);assert.equal(await expectedRegistrarCode(f.context,namespace),'01'.repeat(32));
 assert(!f.calls.includes('native_code'));
 await assert.rejects(verifyRegistrarProvenance(f.context,registrar,namespace),/Registry-approved code/);
});
for(const invalid of [null,{}, {registrar:current,resolver:old,registrar_updates:-1,resolver_updates:0},{registrar:current,resolver:old,registrar_updates:1,resolver_updates:0,extra:true},{registrar:new Uint8Array(31),resolver:old,registrar_updates:1,resolver_updates:0}])test('governed invalid/missing pins never fall back: '+JSON.stringify(invalid),async()=>{
 const f=fixture();f.setCode(invalid);await assert.rejects(expectedRegistrarCode(f.context,namespace));assert(!f.calls.includes('template_hashes'));
});
test('unavailable Registry proof and unsupported policy never use legacy detection',async()=>{
 const f=fixture();f.proof.entries=[];await assert.rejects(expectedRegistrarCode(f.context,namespace));assert.equal(f.calls.length,0);
 const g=fixture();g.setVersion(2);await assert.rejects(expectedRegistrarCode(g.context,namespace));assert(!g.calls.includes('template_hashes'));
});
test('wrong instance key, duplicate authority and malformed authority fail closed',async()=>{
 const f=fixture();f.proof.entries[0].key=new Contract(C(99)).getFootprint();await assert.rejects(expectedRegistrarCode(f.context,namespace));
 const g=fixture();g.data.storage.push(g.data.storage[0]);await assert.rejects(expectedRegistrarCode(g.context,namespace));
 const h=fixture();h.data.storage[0].val=xdr.ScVal.scvVoid();await assert.rejects(expectedRegistrarCode(h.context,namespace));
});
test('post-receipt code proof requires policy observations at least as new as Registry proof',async()=>{
 const f=fixture();assert.equal(await expectedRegistrarCode(f.context,namespace,200),'02'.repeat(32));
 f.setLedger(199);await assert.rejects(expectedRegistrarCode(f.context,namespace,200),/ledger context/);
 const g=fixture();g.proof.latestLedger=199;await assert.rejects(expectedRegistrarCode(g.context,namespace,200),/ledger context/);
});
