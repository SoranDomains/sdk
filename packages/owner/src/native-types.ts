import { hash, scValToNative, xdr } from "@stellar/stellar-sdk";
import { destinationFromNative, type PaymentDestination } from "./payment.js";
import { NativeClaimError, address, amount, bool, bytes32, exactObject, hex, hex32, label, paymentDestinationToScVal, sc, struct, u32, u64, unhex, utf8 } from "./native-codec.js";

export type ClaimAdmission = { type: "open" } | { type: "allowlist"; root: string } | { type: "approval"; account: string };
export type ClaimSettings = { mode: "manual" | "public"; enabled: boolean; admission: ClaimAdmission; feeToken: string; feeAmount: bigint; feeRecipient: string; walletLimit: bigint; approvalAllowance: bigint; approvalRateLimit: bigint; approvalWindowSecs: bigint; approvalTtlSecs: bigint };
export type ClaimConfig = { settings: ClaimSettings; ownerEpoch: bigint; policyVersion: bigint; grantEpoch: bigint };
export type RequestContext = { network: string; registry: string; registrar: string; namespace: string; requestId: string; validAfter: bigint; deadline: bigint };
export type ClaimIntent = { context: RequestContext; label: string; claimant: string; destination: PaymentDestination; resolver: string; expectedGeneration: bigint | null; expectedExpiry: bigint | null; termSecs: bigint; ownerEpoch: bigint; policyVersion: bigint; grantEpoch: bigint; feeToken: string; feeAmount: bigint; feeRecipient: string };
export type ReservedIntent = { context: RequestContext; label: string; holder: string; destination: PaymentDestination; resolver: string; expectedGeneration: bigint | null; expectedExpiry: bigint | null; termSecs: bigint; ownerEpoch: bigint; policyVersion: bigint };
export type TransferIntent = { context: RequestContext; label: string; from: string; to: string; expectedGeneration: bigint; expectedExpiry: bigint; proposalExpires: bigint; destination: PaymentDestination; resolver: string };
export type RenewIntent = { context: RequestContext; label: string; holder: string; expectedGeneration: bigint; expectedExpiry: bigint; termSecs: bigint; minNewExpiry: bigint; maxNewExpiry: bigint };
export type ClaimReceipt = { operation: "claim" | "reserved" | "transfer" | "renew"; intentHash: string; node: string; holder: string; generation: bigint; expiresAt: bigint; feeAmount: bigint; feeToken: string; feeRecipient: string | null; ledger: number; timestamp: bigint };
export type ClaimResult = { status: "fresh" | "replayed"; receipt: ClaimReceipt };
export type ClaimUsage = { publicClaims: bigint; reservedIssues: bigint };
export type ApprovalUsage = { total: bigint; windowUsed: bigint; windowEnds: bigint };
export type ClaimQuote = { network: string; registry: string; registrar: string; namespace: string; resolver: string; label: string; node: string; claimant: string; config: ClaimConfig | null; ownerEpoch: bigint; policyVersion: bigint; available: boolean; reserved: boolean; generation: bigint | null; expiresAt: bigint | null; termSecs: bigint; now: bigint; usage: ClaimUsage; approvalUsage: ApprovalUsage };
export type DestinationPreview = { node: string; holder: string; generation: bigint; expiresAt: bigint; active: boolean; destination: PaymentDestination };

type Codec = { encode(v: unknown): xdr.ScVal; decode(v: unknown): unknown };
const primitive = (validate: (v: unknown) => any, encode: (v: any) => xdr.ScVal): Codec => ({ encode: v => encode(validate(v)), decode: validate });
const U64=primitive(v=>u64(v,"u64 field"),sc.u64), U32=primitive(v=>u32(v,"u32 field"),sc.u32), AMOUNT=primitive(v=>amount(v,"fee amount"),sc.i128), BOOL=primitive(v=>bool(v,"boolean field"),sc.bool);
const ACCOUNT=primitive(v=>address(v,"account","account"),sc.address), CONTRACT=primitive(v=>address(v,"contract","contract"),sc.address), IDENTITY=primitive(v=>address(v,"identity","identity"),sc.address);
const HEX: Codec={encode:v=>sc.bytes(unhex(hex32(v,"bytes32 field"))),decode:v=>hex(bytes32(v,"bytes32 field"))};
const LABEL: Codec={encode:v=>sc.bytes(utf8(label(v))),decode:v=>{if(!(v instanceof Uint8Array))throw new NativeClaimError("label must be on-chain Bytes"); return label(new TextDecoder("utf-8",{fatal:true}).decode(v));}};
const DESTINATION: Codec={encode:v=>paymentDestinationToScVal(v as PaymentDestination),decode:destinationFromNative};
const optional=(inner:Codec):Codec=>({encode:v=>v===null?sc.option(null):inner.encode(v),decode:v=>v===null||v===undefined?null:inner.decode(v)});
const enumeration=(mapping:Record<string,string>):Codec=>({encode:v=>{if(typeof v!=="string"||!Object.hasOwn(mapping,v))throw new NativeClaimError("unsupported enum value");return xdr.ScVal.scvVec([sc.symbol(mapping[v])]);},decode:v=>{if(!Array.isArray(v)||v.length!==1)throw new NativeClaimError("invalid enum result");const entry=Object.entries(mapping).find(([,tag])=>tag===v[0]);if(!entry)throw new NativeClaimError("unknown enum tag");return entry[0];}});
const ADMISSION:Codec={encode:v=>{if(!v||typeof v!=="object")throw new NativeClaimError("invalid admission");const a=v as ClaimAdmission;if(a.type==="open"){exactObject(a,["type"],"open admission");return xdr.ScVal.scvVec([sc.symbol("Open")]);}if(a.type==="allowlist"){exactObject(a,["type","root"],"allowlist admission");return xdr.ScVal.scvVec([sc.symbol("Allowlist"),HEX.encode(a.root)]);}if(a.type==="approval"){exactObject(a,["type","account"],"approval admission");return xdr.ScVal.scvVec([sc.symbol("Approval"),ACCOUNT.encode(a.account)]);}throw new NativeClaimError("unsupported admission");},decode:v=>{if(!Array.isArray(v))throw new NativeClaimError("invalid admission enum");if(v.length===1&&v[0]==="Open")return{type:"open"};if(v.length===2&&v[0]==="Allowlist")return{type:"allowlist",root:HEX.decode(v[1])};if(v.length===2&&v[0]==="Approval")return{type:"approval",account:ACCOUNT.decode(v[1])};throw new NativeClaimError("unknown admission enum");}};
type Fields=Record<string,Codec>;
const snake=(s:string)=>s.replace(/[A-Z]/g,c=>"_"+c.toLowerCase());
function model(fields:Fields):Codec{return{encode:v=>{const value=exactObject(v,Object.keys(fields),"native input");return struct(Object.fromEntries(Object.entries(fields).map(([name,codec])=>[snake(name),codec.encode(value[name])])));},decode:v=>{const value=exactObject(v,Object.keys(fields).map(snake),"native result");return Object.fromEntries(Object.entries(fields).map(([name,codec])=>[name,codec.decode(value[snake(name)])]));}};}
const SETTINGS=model({mode:enumeration({manual:"Manual",public:"Public"}),enabled:BOOL,admission:ADMISSION,feeToken:CONTRACT,feeAmount:AMOUNT,feeRecipient:ACCOUNT,walletLimit:U64,approvalAllowance:U64,approvalRateLimit:U64,approvalWindowSecs:U64,approvalTtlSecs:U64});
const CONFIG=model({settings:SETTINGS,ownerEpoch:U64,policyVersion:U64,grantEpoch:U64});
const CONTEXT=model({network:HEX,registry:CONTRACT,registrar:CONTRACT,namespace:HEX,requestId:HEX,validAfter:U64,deadline:U64});
const CLAIM=model({context:CONTEXT,label:LABEL,claimant:ACCOUNT,destination:DESTINATION,resolver:CONTRACT,expectedGeneration:optional(U64),expectedExpiry:optional(U64),termSecs:U64,ownerEpoch:U64,policyVersion:U64,grantEpoch:U64,feeToken:CONTRACT,feeAmount:AMOUNT,feeRecipient:ACCOUNT});
const RESERVED=model({context:CONTEXT,label:LABEL,holder:ACCOUNT,destination:DESTINATION,resolver:CONTRACT,expectedGeneration:optional(U64),expectedExpiry:optional(U64),termSecs:U64,ownerEpoch:U64,policyVersion:U64});
const TRANSFER=model({context:CONTEXT,label:LABEL,from:IDENTITY,to:ACCOUNT,expectedGeneration:U64,expectedExpiry:U64,proposalExpires:U64,destination:DESTINATION,resolver:CONTRACT});
const RENEW=model({context:CONTEXT,label:LABEL,holder:ACCOUNT,expectedGeneration:U64,expectedExpiry:U64,termSecs:U64,minNewExpiry:U64,maxNewExpiry:U64});
const USAGE=model({publicClaims:U64,reservedIssues:U64}), APPROVAL_USAGE=model({total:U64,windowUsed:U64,windowEnds:U64});
const CONFIG_STATE:Codec={encode:v=>v===null?xdr.ScVal.scvVec([sc.symbol("Unconfigured")]):xdr.ScVal.scvVec([sc.symbol("Configured"),CONFIG.encode(v)]),decode:v=>{if(!Array.isArray(v))throw new NativeClaimError("invalid claim config state");if(v.length===1&&v[0]==="Unconfigured")return null;if(v.length===2&&v[0]==="Configured")return CONFIG.decode(v[1]);throw new NativeClaimError("invalid claim config state");}};
const QUOTE=model({network:HEX,registry:CONTRACT,registrar:CONTRACT,namespace:HEX,resolver:CONTRACT,label:LABEL,node:HEX,claimant:ACCOUNT,config:CONFIG_STATE,ownerEpoch:U64,policyVersion:U64,available:BOOL,reserved:BOOL,generation:optional(U64),expiresAt:optional(U64),termSecs:U64,now:U64,usage:USAGE,approvalUsage:APPROVAL_USAGE});
const RECEIPT=model({operation:enumeration({claim:"Claim",reserved:"Reserved",transfer:"Transfer",renew:"Renew"}),intentHash:HEX,node:HEX,holder:IDENTITY,generation:U64,expiresAt:U64,feeAmount:AMOUNT,feeToken:CONTRACT,feeRecipient:optional(ACCOUNT),ledger:U32,timestamp:U64});
const PREVIEW=model({node:HEX,holder:IDENTITY,generation:U64,expiresAt:U64,active:BOOL,destination:DESTINATION});

export function claimSettingsToScVal(value:ClaimSettings):xdr.ScVal{
 const encoded=SETTINGS.encode(value);
 if(value.admission.type==="approval"){
  if(value.approvalAllowance===0n||value.approvalRateLimit===0n||value.approvalWindowSecs===0n||value.approvalWindowSecs>31536000n||value.approvalTtlSecs===0n||value.approvalTtlSecs>3600n)throw new NativeClaimError("approval mode requires explicit bounded admission budgets, window and lifetime");
  if(value.admission.account===value.feeRecipient)throw new NativeClaimError("eligibility account must differ from fee treasury");
 }else if(value.approvalAllowance!==0n||value.approvalRateLimit!==0n||value.approvalWindowSecs!==0n||value.approvalTtlSecs!==0n)throw new NativeClaimError("approval settings must be zero outside approval mode");
 return encoded;
}
export const claimPolicyInputToScVal=claimSettingsToScVal;
export const claimLabelToScVal=(value:string)=>LABEL.encode(value);
export const claimConfigFromNative=(value:unknown)=>CONFIG.decode(value) as ClaimConfig;
export const claimQuoteFromNative=(value:unknown)=>QUOTE.decode(value) as ClaimQuote;
export const claimUsageFromNative=(value:unknown)=>USAGE.decode(value) as ClaimUsage;
export const approvalUsageFromNative=(value:unknown)=>APPROVAL_USAGE.decode(value) as ApprovalUsage;
export const destinationPreviewFromNative=(value:unknown)=>PREVIEW.decode(value) as DestinationPreview;
export const claimReceiptFromNative=(value:unknown)=>RECEIPT.decode(value) as ClaimReceipt;
function validContext(c:RequestContext):void{if(c.deadline<=c.validAfter||c.deadline-c.validAfter>3600n)throw new NativeClaimError("business intent lifetime must be positive and at most 3600 seconds");}
export function claimIntentToScVal(value:ClaimIntent):xdr.ScVal{const result=CLAIM.encode(value);validContext(value.context);if((value.expectedGeneration===null)!==(value.expectedExpiry===null))throw new NativeClaimError("generation and expiry expectations must both be present or absent");return result;}
export function reservedIntentToScVal(value:ReservedIntent):xdr.ScVal{const result=RESERVED.encode(value);validContext(value.context);if((value.expectedGeneration===null)!==(value.expectedExpiry===null))throw new NativeClaimError("generation and expiry expectations must both be present or absent");return result;}
export function transferIntentToScVal(value:TransferIntent):xdr.ScVal{const result=TRANSFER.encode(value);validContext(value.context);return result;}
export function renewIntentToScVal(value:RenewIntent):xdr.ScVal{const result=RENEW.encode(value);validContext(value.context);if(value.termSecs===0n||value.maxNewExpiry<value.minNewExpiry)throw new NativeClaimError("invalid renewal bounds");return result;}
export const claimIntentFromNative=(value:unknown)=>CLAIM.decode(value) as ClaimIntent;
export const transferIntentFromNative=(value:unknown)=>TRANSFER.decode(value) as TransferIntent;
export const renewIntentFromNative=(value:unknown)=>RENEW.decode(value) as RenewIntent;
export function claimResultFromNative(value:unknown):ClaimResult{if(!Array.isArray(value)||value.length!==2||!["Fresh","Replayed"].includes(value[0]))throw new NativeClaimError("invalid claim result");return{status:value[0]==="Fresh"?"fresh":"replayed",receipt:claimReceiptFromNative(value[1])};}
export function nativeIntentHash(method:"claim"|"issue_reserved_with_destination"|"accept_transfer_with_destination"|"renew_holder",value:xdr.ScVal):string{return hex(hash(xdr.ScVal.scvVec([sc.symbol(method),value]).toXDR()));}
/** Lossless public recovery JSON; only declared bigint fields receive the tagged encoding. */
export function stringifyNativeIntent(value:ClaimIntent|TransferIntent|RenewIntent|ReservedIntent):string{return JSON.stringify(value,(_key,v)=>typeof v==="bigint"?{$u64:v.toString()}:v);}
export function parseNativeClaimIntent(json:string):ClaimIntent{if(json.length>16384)throw new NativeClaimError("claim recovery reference is too large");const raw=JSON.parse(json,(_key,v)=>{if(v&&typeof v==="object"&&!Array.isArray(v)&&Object.keys(v).join(",")==="$u64"){if(typeof v.$u64!=="string"||! /^(0|[1-9][0-9]*)$/.test(v.$u64))throw new NativeClaimError("invalid recovery integer");return BigInt(v.$u64);}return v;});return claimIntentFromNative(scValToNative(claimIntentToScVal(raw)));}

export function parseNativeTransferIntent(json:string):TransferIntent { return parseLifecycleIntent(json,TRANSFER,transferIntentToScVal) as TransferIntent; }
export function parseNativeRenewIntent(json:string):RenewIntent { return parseLifecycleIntent(json,RENEW,renewIntentToScVal) as RenewIntent; }
function parseLifecycleIntent(json:string,codec:Codec,encode:(value:any)=>xdr.ScVal):unknown { if(json.length>16384)throw new NativeClaimError("lifecycle intent is too large");const raw=JSON.parse(json,(_key,v)=>{if(v&&typeof v==="object"&&!Array.isArray(v)&&Object.keys(v).join(",")==="$u64"){if(typeof v.$u64!=="string"||! /^(0|[1-9][0-9]*)$/.test(v.$u64))throw new NativeClaimError("invalid recovery integer");return BigInt(v.$u64);}return v;});return codec.decode(scValToNative(encode(raw))); }
