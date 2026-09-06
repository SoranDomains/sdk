import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {Keypair,xdr,scValToNative} from '@stellar/stellar-sdk';
import {SoranHolder,NativeClaimError,claimIntentFromNative,stringifyNativeIntent} from '@sorandomains/holder';
import {SoranOwner} from '@sorandomains/owner';
import {registerReadTools,registerWriteTools} from '../src/tools.js';
async function tools(withKey=true,options:{maxNativeFeeStroops?:bigint}={}){const handlers=new Map<string,(args:any)=>Promise<any>>(),schemas=new Map<string,any>();const server={tool(name:string,_desc:string,schema:any,handler:any){handlers.set(name,handler);schemas.set(name,schema);}};await registerWriteTools(server as never,withKey?{secret:Keypair.random().secret(),...options}:{});return{handlers,schemas,server};}
test('native signing tools remain local and require a configured signer',async()=>{const absent=await tools(false);assert(!absent.handlers.has('claim_username'));const ready=await tools();for(const name of ['claim_username','native_claim_quote','configure_native_claims','reserve_usernames','assign_reserved_username','accept_name_transfer_with_destination','renew_held_name'])assert(ready.handlers.has(name));const remote=new Map();registerReadTools({tool:(name:string)=>remote.set(name,true)} as never);assert(!remote.has('claim_username'));});
test('native MCP parses exact intent and retains pending transaction hash',async()=>{const old=SoranHolder.prototype.claim;const vector=JSON.parse(readFileSync(new URL('../../holder/test/fixtures/native-claim-v1.json',import.meta.url),'utf8'));const intent=claimIntentFromNative(scValToNative(xdr.ScVal.fromXDR(vector.claimIntentXdrHex,'hex')));try{SoranHolder.prototype.claim=async(value)=>{assert.deepEqual(value,intent);throw new NativeClaimError('outcome unknown','pending','ab'.repeat(32));};const ready=await tools();const result=await ready.handlers.get('claim_username')!({intentJson:stringifyNativeIntent(intent)});assert.equal(result.isError,true);const payload=JSON.parse(result.content[0].text);assert.equal(payload.txHash,'ab'.repeat(32));assert.equal(payload.outcome,'pending');}finally{SoranHolder.prototype.claim=old;}});
test('native MCP owner settings use lossless integers and explicit approval configuration',async()=>{const old=SoranOwner.prototype.configureClaims;let seen=false;try{SoranOwner.prototype.configureClaims=async(_ns,settings)=>{seen=true;assert.equal(settings.feeAmount,9007199254740993n);assert.equal(settings.walletLimit,0n);return{hash:'h',ledger:1,config:{settings,ownerEpoch:1n,policyVersion:2n,grantEpoch:3n}};};const ready=await tools();const value={mode:'public',enabled:true,admission:{type:'open'},feeToken:'token',feeAmount:'9007199254740993',feeRecipient:'recipient',walletLimit:'0',approvalAllowance:'0',approvalRateLimit:'0',approvalWindowSecs:'0',approvalTtlSecs:'0'};assert(ready.schemas.get('configure_native_claims').settings.safeParse(value).success);assert(!ready.schemas.get('configure_native_claims').settings.safeParse({...value,feeAmount:'01'}).success);assert(!ready.schemas.get('configure_native_claims').settings.safeParse({...value,unexpected:true}).success);const result=await ready.handlers.get('configure_native_claims')!({namespace:'nova',settings:value});assert.equal(result.isError,undefined);assert(seen);}finally{SoranOwner.prototype.configureClaims=old;}});

test('native MCP fee ceiling remains local operator configuration, never an agent tool argument',async()=>{
 const original=SoranOwner.prototype.configureClaims;let cap:bigint|undefined;
 try{SoranOwner.prototype.configureClaims=async function(){cap=(this as any).maxNativeFeeStroops;return{} as any;};
 for(const requested of [undefined,2000000000n]){const ready=await tools(true,{maxNativeFeeStroops:requested});await ready.handlers.get('configure_native_claims')!({namespace:'nova',settings:{feeAmount:'0',walletLimit:'0',approvalAllowance:'0',approvalRateLimit:'0',approvalWindowSecs:'0',approvalTtlSecs:'0'}});assert.equal(cap,requested??50000000n);assert(!('maxNativeFeeStroops' in ready.schemas.get('configure_native_claims')));}
 await assert.rejects(tools(true,{maxNativeFeeStroops:4294967296n}));
 }finally{SoranOwner.prototype.configureClaims=original;}
});

test('stdio refuses malformed native fee limits before registering a signing tool',()=>{
 for(const value of ['0','050000000','4294967296','50000000n']){
 const result=spawnSync(process.execPath,[fileURLToPath(new URL('../dist/stdio.js',import.meta.url))],{env:{SORAN_MAX_NATIVE_FEE_STROOPS:value},encoding:'utf8',timeout:5000});
 assert.notEqual(result.status,0);assert.match(result.stderr,/SORAN_MAX_NATIVE_FEE_STROOPS must be canonical decimal/);
 }
});

test('native receipt tool surfaces unavailable provenance instead of completion or empty history',async()=>{
 const previous=SoranHolder.prototype.claimReceipt;
 try{
  SoranHolder.prototype.claimReceipt=async()=>{throw new NativeClaimError('RPC read has missing, invalid or stale ledger context','unavailable');};
  const ready=await tools();const result=await ready.handlers.get('native_claim_receipt')!({namespace:'nova',claimant:Keypair.random().publicKey(),requestId:'ab'.repeat(32)});
  assert.equal(result.isError,true);const body=JSON.parse(result.content[0].text);assert.equal(body.outcome,'unavailable');assert.match(body.message,/ledger context/);
 }finally{SoranHolder.prototype.claimReceipt=previous;}
});
