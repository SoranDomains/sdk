import assert from 'node:assert/strict';
import test from 'node:test';
import {Keypair} from '@stellar/stellar-sdk';
import {Soran,LEGACY_DEPLOYMENTS,DEPLOYMENTS} from '../src/index.js';
const old=LEGACY_DEPLOYMENTS.testnet20260905;
test('explicit historical preset retains immutable Registry and payment lookup anchors',async()=>{
 assert.equal(old.registryId,'CASORANI5CN2NJFEO2MGTRDA35AOEF3D3OCVBWN3FS6B6FXNQ74RTJ7H');
 assert.equal(old.lookupId,'CDSORANKG77YZITKWCLWGPKLB2R3HPTP4D6KKZZ7X3R5HLXLMNOTGCDD');
 const client=new Soran({...old}),wallet=Keypair.random().publicKey();
 Object.assign(client,{read:async(id:string,method:string)=>{assert.equal(id,old.lookupId);if(method==='registry')return old.registryId;if(method==='version'||method==='destination_version')return 2;if(method==='resolve_v2')return{name:'alice.nova',registrar:old.registryId,resolver:old.lookupId,generation:0n,result:['NativePayment',['Direct',{address:wallet,memo:['None']}]]};throw new Error('unexpected read '+method);}});
 assert.deepEqual(await client.resolvePayment('alice.nova'),{address:wallet,memo:{type:'none'}});
});
test('default lookup errors do not switch to the historical deployment',async()=>{
 const client=new Soran();let reads=0;
 Object.assign(client,{read:async(id:string)=>{reads++;assert.equal(id,DEPLOYMENTS.testnet.lookupId);throw new Error('selected deployment unavailable');}});
 await assert.rejects(client.resolvePayment('alice.nova'),/unavailable/);assert.equal(reads,2);
});
