import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {xdr,scValToNative} from '@stellar/stellar-sdk';
import {claimIntentFromNative,stringifyNativeIntent,type ClaimReceipt} from '@sorandomains/holder';
import {SignupNames,type RecoveryStore,type PublicPendingClaim} from './flow.js';
const v=JSON.parse(readFileSync(new URL('./native-claim-v1.json',import.meta.url),'utf8'));
const intentJson=stringifyNativeIntent(claimIntentFromNative(scValToNative(xdr.ScVal.fromXDR(v.claimIntentXdrHex,'hex'))));
const receipt={intentHash:v.claimIntentHash} as ClaimReceipt;
function setup({complete=false,cancel=false,unknown=false,race=false}={}){let current:PublicPendingClaim|null={intentJson,transactionHash:null},archived=0,claims=0;const store:RecoveryStore={load:async()=>current,save:async value=>{current=value;},archiveAndClear:async expected=>{if(race)current={intentJson:'newer',transactionHash:'newer-hash'};if(current?.intentJson!==expected)return false;archived++;current=null;return true;},clearUnsignedHash:async(expected,hash)=>{if(current?.intentJson!==expected||current.transactionHash!==hash)return false;current={intentJson:expected,transactionHash:null};return true;}};const closed=new Error('wallet declined without signature');const holder={recoverClaim:async()=>complete?receipt:null,claim:async(_intent:any,opts:any)=>{claims++;await opts.onPrepared({hash:'reviewed-hash'});if(cancel)throw closed;if(unknown)throw new Error('transport unknown');return{status:'fresh',receipt,transaction:{hash:'reviewed-hash',ledger:1}};}};return{flow:new SignupNames(holder as never,{} as never,store,e=>e===closed),state:()=>({current,archived,claims})};}
test('resume of returning sign-in reads history without a new claim',async()=>{const s=setup({complete:true});assert.equal((await s.flow.resume()).state,'historically-completed');assert.equal(s.state().claims,0);});
test('verified completion archives receipt and clears exact pending intent',async()=>{const s=setup({complete:true});assert.equal((await s.flow.finalizeCompleted()).archived,true);assert.equal(s.state().current,null);assert.equal(s.state().archived,1);});
test('completion CAS never erases a newer operation',async()=>{const s=setup({complete:true,race:true});assert.equal((await s.flow.finalizeCompleted()).archived,false);assert.equal(s.state().current?.intentJson,'newer');});
test('proven unsigned dismissal retains original intent and allows same-request retry',async()=>{const s=setup({cancel:true});await assert.rejects(s.flow.submit(),/declined/);assert.deepEqual(s.state().current,{intentJson,transactionHash:null});});
test('unknown submission keeps hash and cannot finalize or blindly submit again',async()=>{const s=setup({unknown:true});await assert.rejects(s.flow.submit(),/transport unknown/);assert.equal(s.state().current?.transactionHash,'reviewed-hash');await assert.rejects(s.flow.submit(),/already submitted or signed/);await assert.rejects(s.flow.finalizeCompleted(),/unresolved/);assert.equal(s.state().claims,1);});

const original = claimIntentFromNative(scValToNative(xdr.ScVal.fromXDR(v.claimIntentXdrHex,'hex')));
const metadata = {name:'alice.nova',registrar:original.context.registrar,holder:original.claimant,active:true,generation:0n};
const resolution = {kind:'nativePayment',name:metadata.name,registrar:metadata.registrar,resolver:original.resolver,generation:0n,payment:original.destination};
function existing(meta:unknown=metadata,payment:unknown=resolution){
 const lookup={nameMetadata:async(name:string)=>{assert.equal(name,'alice.nova');return meta;},lookup:async(name:string)=>{assert.equal(name,'alice.nova');return payment;},resolvePayment:async()=>assert.fail('generation-stripped payment lookup must not be used')};
 return new SignupNames({} as never,lookup as never,{} as never);
}
test('existing-name verification keeps the complete route and canonical generation while preserving its result shape',async()=>{
 const result=await existing().verifyExistingName('ALICE.NOVA',original.claimant);
 assert.deepEqual(result,{name:'ALICE.NOVA',holder:original.claimant,generation:0n,payment:original.destination});
});
test('normal transfer between ownership and payment reads cannot identify the former holder as current',async()=>{
 await assert.rejects(existing(metadata,{...resolution,generation:1n}).verifyExistingName('alice.nova',original.claimant),/snapshots differ/);
});
for(const [name,payment]of Object.entries({
 'another Registrar':{...resolution,registrar:original.resolver},
 'another name':{...resolution,name:'bob.nova'},
 'legacy address with unknown memo':{...resolution,kind:'legacyAddress',address:original.claimant},
}))test(`existing-name verification rejects ${name}`,async()=>{
 await assert.rejects(existing(metadata,payment).verifyExistingName('alice.nova',original.claimant),/snapshots differ/);
});
test('existing-name verification rejects metadata from another name and a different holder',async()=>{
 await assert.rejects(existing({...metadata,name:'bob.nova'}).verifyExistingName('alice.nova',original.claimant),/snapshots differ/);
 await assert.rejects(existing({...metadata,holder:original.feeRecipient}).verifyExistingName('alice.nova',original.claimant),/does not currently hold/);
});
