import { hash, scValToNative, xdr } from "@stellar/stellar-sdk";
import { NativeClaimError, address, bytes32, exactObject, hex, hex32, label, namespaceNode, sc, u64, unhex, utf8 } from "./native-codec.js";
import { authorizedInvocation, type NativeAuthorizationPlan, type NativeInvocation } from "./native-auth.js";
import { nativeCapability, requireNative, verifyRegistrarProvenance, prepareNative, sendNative, type NativeContext, type NativeWriteOptions, type NativePrepared } from "./native-transport.js";
import { claimIntentToScVal, claimIntentFromNative, claimQuoteFromNative, claimReceiptFromNative, claimResultFromNative, destinationPreviewFromNative, transferIntentToScVal, renewIntentToScVal, nativeIntentHash, claimLabelToScVal, type ClaimIntent, type ClaimQuote, type ClaimReceipt, type ClaimResult, type RequestContext, type TransferIntent, type RenewIntent, type DestinationPreview } from "./native-types.js";
import { paymentDestinationToScVal } from "./native-codec.js";
import { validatePaymentDestination, type PaymentDestination } from "./payment.js";
import { verifyClaimAllowlistProof } from "./native-allowlist.js";

export type ClaimRequestOptions = { requestId: string; deadline: bigint; validAfter?: bigint };
export type ClaimSubmitOptions = NativeWriteOptions & { proof?: readonly string[] };
export type NativeClaimSubmission = ClaimResult & { transaction: { hash: string; ledger: number } | null };
export type PreparedClaim = NativePrepared & { intent: ClaimIntent; plan: NativeAuthorizationPlan };
const canonicalNamespace=(value:string)=>{if(typeof value!=="string"||/[^\x00-\x7f]/.test(value))throw new NativeClaimError("namespace must contain ASCII characters only");return label(value.toLowerCase());};
const names=(name:string)=>{if(typeof name!=="string"||/[^\x00-\x7f]/.test(name))throw new NativeClaimError("name must be ASCII");const parts=name.toLowerCase().split(".");if(parts.length!==2)throw new NativeClaimError("expected label.namespace");return{label:label(parts[0]),namespace:label(parts[1])};};
const networkId=(passphrase:string)=>hex(hash(utf8(passphrase)));
function scoped(context:NativeContext,request:RequestContext):void{if(request.registry!==context.registryId||request.network!==networkId(context.passphrase))throw new NativeClaimError("intent targets a different network or Registry");}
function contextFromQuote(quote:ClaimQuote,opts:ClaimRequestOptions):RequestContext{return{network:quote.network,registry:quote.registry,registrar:quote.registrar,namespace:quote.namespace,requestId:hex32(opts.requestId,"request ID"),validAfter:opts.validAfter??quote.now,deadline:opts.deadline};}
export function createClaimIntent(quote:ClaimQuote,destination:PaymentDestination,options:ClaimRequestOptions):ClaimIntent{
 if(!quote.config)throw new NativeClaimError("namespace public claims are not configured","unsupported");
 const config=quote.config;const settings=config.settings;
 const result:ClaimIntent={context:contextFromQuote(quote,options),label:quote.label,claimant:quote.claimant,destination:validatePaymentDestination(destination),resolver:quote.resolver,expectedGeneration:quote.generation,expectedExpiry:quote.expiresAt,termSecs:quote.termSecs,ownerEpoch:quote.ownerEpoch,policyVersion:quote.policyVersion,grantEpoch:config.grantEpoch,feeToken:settings.feeToken,feeAmount:settings.feeAmount,feeRecipient:settings.feeRecipient};
 return claimIntentFromNative(scValToNative(claimIntentToScVal(result)));
}
function initialization(resolver:string,nameLabel:string,holder:string,generation:bigint,destination:PaymentDestination):NativeInvocation{return{contract:resolver,method:"initialize_destination",args:[claimLabelToScVal(nameLabel),sc.address(holder),sc.u64(u64(generation,"new generation")),paymentDestinationToScVal(destination)]};}
function receiptMatches(receipt:ClaimReceipt,method:Parameters<typeof nativeIntentHash>[0],intent:xdr.ScVal,holder:string):void{
 if(receipt.intentHash!==nativeIntentHash(method,intent)||receipt.holder!==holder)throw new NativeClaimError("request ID already belongs to a different immutable intent");
 const raw=scValToNative(intent), expectedOperation=({claim:"claim",issue_reserved_with_destination:"reserved",accept_transfer_with_destination:"transfer",renew_holder:"renew"} as const)[method];
 const nodeBytes=new Uint8Array(64);nodeBytes.set(raw.context.namespace);nodeBytes.set(hash(raw.label),32);
 if(receipt.operation!==expectedOperation||receipt.node!==hex(hash(nodeBytes)))throw new NativeClaimError("receipt operation/name differs from intent");
 const generation=method==="renew_holder"?raw.expected_generation:raw.expected_generation===null||raw.expected_generation===undefined?0n:raw.expected_generation+1n;
 if(receipt.generation!==generation)throw new NativeClaimError("receipt generation differs from intent");
 if(method==="claim"){
  if(receipt.feeAmount!==raw.fee_amount||receipt.feeToken!==raw.fee_token||receipt.feeRecipient!==(raw.fee_amount>0n?raw.fee_recipient:null))throw new NativeClaimError("receipt fee settlement differs from intent");
  if(receipt.expiresAt!==(raw.term_secs===0n?0n:receipt.timestamp+raw.term_secs))throw new NativeClaimError("receipt lease differs from intent");
 }else{
  if(receipt.feeAmount!==0n||receipt.feeRecipient!==null)throw new NativeClaimError("lifecycle receipt unexpectedly contains a username fee");
  if(method==="accept_transfer_with_destination"&&receipt.expiresAt!==raw.expected_expiry)throw new NativeClaimError("transfer receipt changed the lease");
  if(method==="renew_holder"&&(receipt.expiresAt<raw.min_new_expiry||receipt.expiresAt>raw.max_new_expiry||receipt.expiresAt!==(receipt.timestamp>raw.expected_expiry?receipt.timestamp:raw.expected_expiry)+raw.term_secs))throw new NativeClaimError("renewal receipt differs from signed lease bounds");
 }
}

function confirmedResult(result:{hash:string;ledger:number;value:unknown},method:Parameters<typeof nativeIntentHash>[0],encoded:xdr.ScVal,holder:string):NativeClaimSubmission{try{const decoded=claimResultFromNative(result.value);receiptMatches(decoded.receipt,method,encoded,holder);return{...decoded,transaction:{hash:result.hash,ledger:result.ledger}};}catch(error){throw new NativeClaimError(`transaction confirmed but result could not be verified: ${String(error)}; recover the original request`,"pending",result.hash);}}

export class NativeHolderClient {
 constructor(private context:NativeContext){}
 async nativeClaimCapability(namespace:string){return nativeCapability(this.context,canonicalNamespace(namespace));}
 private async registrar(namespace:string):Promise<string>{
  const node=namespaceNode(namespace);const registrar=address(await this.context.read(this.context.registryId,"registrar_of",[sc.bytes(node)]),"contract","Registrar");
  await this.checkRegistrar(registrar,hex(node));return registrar;
 }
 private async checkRegistrar(registrar:string,node:string):Promise<void>{
  await verifyRegistrarProvenance(this.context,registrar,node);
  const [anchors,version]=await Promise.all([this.context.read(registrar,"anchors",[]),this.context.read(registrar,"claim_version",[])]);
  const attested = await this.context.read(this.context.registryId,"registrar_of",[sc.bytes(unhex(node))]);
  if(attested!==registrar)throw new NativeClaimError("intent Registrar is not the Registry attestation","unavailable");
  if(version!==1)throw new NativeClaimError("unsupported native claim version","unsupported");
  if(!Array.isArray(anchors)||anchors.length!==2||anchors[0]!==this.context.registryId||hex(bytes32(anchors[1],"namespace anchor"))!==node)throw new NativeClaimError("Registrar anchors differ from intent","unavailable");
 }
 async claimQuote(name:string,claimant?:string):Promise<ClaimQuote>{
  const parsed=names(name);const cap=await requireNative(this.context,parsed.namespace);
  const wallet=address(claimant??await this.context.signer.publicKey(),"account","claimant");
  const quote=claimQuoteFromNative(await this.context.read(cap.registrar,"claim_quote",[claimLabelToScVal(parsed.label),sc.address(wallet)]));
  this.checkQuote(quote,cap.registrar,hex(namespaceNode(parsed.namespace)),parsed.label,wallet);
  if(quote.resolver!==cap.resolver)throw new NativeClaimError("quote Resolver differs from the selected native binding","unavailable");
  return quote;
 }
 private checkQuote(quote:ClaimQuote,registrar:string,node:string,nameLabel:string,wallet:string):void{
  if(quote.network!==networkId(this.context.passphrase)||quote.registry!==this.context.registryId||quote.registrar!==registrar||quote.namespace!==node||quote.label!==nameLabel||quote.claimant!==wallet)throw new NativeClaimError("claim quote differs from requested network, namespace or claimant","unavailable");
  const bytes=new Uint8Array(64);bytes.set(unhex(node));bytes.set(hash(utf8(nameLabel)),32);
  if(quote.node!==hex(hash(bytes)))throw new NativeClaimError("quote name node is invalid","unavailable");
 }
 async claimReceipt(namespace:string,claimant:string,requestId:string):Promise<ClaimReceipt|null>{return this.receiptAt(await this.registrar(canonicalNamespace(namespace)),claimant,requestId);}
 private async receiptAt(registrar:string,claimant:string,requestId:string):Promise<ClaimReceipt|null>{
  const raw=await this.context.read(registrar,"claim_receipt",[sc.address(address(claimant,"identity","receipt holder")),sc.bytes(unhex(requestId))]);
  return raw===null?null:claimReceiptFromNative(raw);
 }
 async recoverClaim(intent:ClaimIntent):Promise<ClaimReceipt|null>{const encoded=claimIntentToScVal(intent);scoped(this.context,intent.context);await verifyRegistrarProvenance(this.context,intent.context.registrar,intent.context.namespace);if(await this.context.read(this.context.registryId,"registrar_of",[sc.bytes(unhex(intent.context.namespace))])!==intent.context.registrar)throw new NativeClaimError("recovery Registrar is not the Registry attestation","unavailable");const receipt=await this.receiptAt(intent.context.registrar,intent.claimant,intent.context.requestId);if(receipt)receiptMatches(receipt,"claim",encoded,intent.claimant);return receipt;}
 private async planClaim(input:ClaimIntent,proof:readonly string[]=[]):Promise<{intent:ClaimIntent;plan:NativeAuthorizationPlan}>{
  const encoded=claimIntentToScVal(input);const intent=claimIntentFromNative(scValToNative(encoded));scoped(this.context,intent.context);
  const wallet=address(await this.context.signer.publicKey(),"account","claimant");if(intent.claimant!==wallet)throw new NativeClaimError("intent claimant is not the connected wallet","authorization");
  await this.checkRegistrar(intent.context.registrar,intent.context.namespace);
  const pair=await this.context.read(this.context.registryId,"native_contracts",[sc.bytes(unhex(intent.context.namespace))]);
  if(!Array.isArray(pair)||pair.length!==2||pair[0]!==intent.context.registrar||pair[1]!==intent.resolver)throw new NativeClaimError("intent differs from current clean native contract bindings","unavailable");
  const quote=claimQuoteFromNative(await this.context.read(intent.context.registrar,"claim_quote",[claimLabelToScVal(intent.label),sc.address(wallet)]));this.checkQuote(quote,intent.context.registrar,intent.context.namespace,intent.label,wallet);
  const config=quote.config;if(!config||config.settings.mode!=="public"||!config.settings.enabled)throw new NativeClaimError("public claiming is disabled","unavailable");
  if(!quote.available||quote.reserved)throw new NativeClaimError(quote.reserved?"username is reserved":"username is unavailable");
  if(quote.now<intent.context.validAfter||quote.now>intent.context.deadline)throw new NativeClaimError("claim intent is outside its business deadline");
  if(config.ownerEpoch!==quote.ownerEpoch||config.policyVersion!==quote.policyVersion||intent.ownerEpoch!==quote.ownerEpoch||intent.policyVersion!==quote.policyVersion||intent.grantEpoch!==config.grantEpoch||intent.resolver!==quote.resolver||intent.expectedGeneration!==quote.generation||intent.expectedExpiry!==quote.expiresAt||intent.termSecs!==quote.termSecs||intent.feeToken!==config.settings.feeToken||intent.feeAmount!==config.settings.feeAmount||intent.feeRecipient!==config.settings.feeRecipient)throw new NativeClaimError("claim terms changed; reconcile the original request before reviewing a replacement");
  const nativeToken=await this.context.read(intent.context.registrar,"native_fee_token",[]);if(nativeToken!==intent.feeToken)throw new NativeClaimError("claim fee is not the canonical native token");
  if(config.settings.walletLimit>0n&&quote.usage.publicClaims>=config.settings.walletLimit)throw new NativeClaimError("lifetime wallet claim limit reached");
  const admission=config.settings.admission;if(!Array.isArray(proof)||proof.length>32)throw new NativeClaimError("allowlist proof exceeds 32 siblings");
  if(admission.type==="allowlist"){if(!verifyClaimAllowlistProof({network:intent.context.network,registry:intent.context.registry,namespace:intent.context.namespace,registrar:intent.context.registrar},wallet,proof,admission.root))throw new NativeClaimError("wallet is not in the committed allowlist");}else if(proof.length)throw new NativeClaimError("this admission mode does not accept an allowlist proof");
  const children:NativeInvocation[]=[];
  if(intent.feeAmount>0n)children.push({contract:intent.feeToken,method:"transfer",args:[sc.address(wallet),sc.address(intent.feeRecipient),sc.i128(intent.feeAmount)]});
  children.push(initialization(intent.resolver,intent.label,wallet,intent.expectedGeneration===null?0n:intent.expectedGeneration+1n,intent.destination));
  const plan:NativeAuthorizationPlan={source:wallet,contract:intent.context.registrar,method:"claim",args:[encoded,xdr.ScVal.scvVec(proof.map(value=>sc.bytes(unhex(value))))],sourceInvocation:{contract:intent.context.registrar,method:"claim",args:[encoded],children},maxFeeStroops:this.context.maxFeeStroops};
  if(admission.type==="approval"){
   if(admission.account===wallet||admission.account===intent.feeRecipient)throw new NativeClaimError("eligibility account must be separate from claimant and treasury","authorization");
   if(intent.context.deadline-intent.context.validAfter>config.settings.approvalTtlSecs)throw new NativeClaimError("claim lifetime exceeds the current approval lifetime");
   if(quote.approvalUsage.total>=config.settings.approvalAllowance)throw new NativeClaimError("cumulative approval allowance exhausted");
   if(quote.now<quote.approvalUsage.windowEnds&&quote.approvalUsage.windowUsed>=config.settings.approvalRateLimit)throw new NativeClaimError("approval rate limit reached");
   const latest=await this.context.server.getLatestLedger();
   // Ledger credential TTL and timestamp business TTL are separate ceilings. At most 60 ledgers per SDK approval.
   const remaining=intent.context.deadline-quote.now;const ledgerSpan=Math.max(1,Math.min(60,Number(remaining)));
   plan.eligibility={account:admission.account,invocation:{contract:intent.context.registrar,method:"claim",args:[encoded]},latestLedger:latest.sequence,maxExpirationLedger:latest.sequence+ledgerSpan};
  }
  return{intent,plan};
 }
 async buildClaim(intent:ClaimIntent,options:ClaimSubmitOptions={}):Promise<PreparedClaim>{
  if(await this.recoverClaim(intent))throw new NativeClaimError("this request already completed; recover its receipt instead of building a transaction");
  const built=await this.planClaim(intent,options.proof);const {prepared}=await prepareNative(this.context,built.plan,options);return{...prepared,intent:built.intent,plan:built.plan};
 }
 async claim(intent:ClaimIntent,options:ClaimSubmitOptions={}):Promise<NativeClaimSubmission>{
  // Snapshot before any awaits: callers cannot mutate reviewed destination/amount mid-flow.
  const snapshot=claimIntentFromNative(scValToNative(claimIntentToScVal(intent)));
  return this.context.serialize(async()=>{const old=await this.recoverClaim(snapshot);if(old)return{status:"replayed",receipt:old,transaction:null};const {plan}=await this.planClaim(snapshot,options.proof);const result=await sendNative(this.context,plan,options);return confirmedResult(result,"claim",claimIntentToScVal(snapshot),snapshot.claimant);});
 }
 async renewalPreview(name:string):Promise<DestinationPreview>{
  const parsed=names(name),registrar=await this.registrar(parsed.namespace);const raw=exactObject(await this.context.read(registrar,"record_of",[claimLabelToScVal(parsed.label)]),["holder","address","expires_at","generation"],"name record");
  const resolver=address(await this.context.read(this.context.registryId,"resolver_of",[sc.bytes(namespaceNode(parsed.namespace))]),"contract","Resolver");
  const result=destinationPreviewFromNative(await this.context.read(resolver,"preview_destination",[xdr.ScVal.scvString(`${parsed.label}.${parsed.namespace}`),sc.u64(u64(raw.generation,"name generation"))]));
  if(result.holder!==raw.holder||result.generation!==raw.generation||result.expiresAt!==raw.expires_at)throw new NativeClaimError("renewal preview no longer matches name state","unavailable");return result;
 }
 async acceptNameTransferWithDestination(input:TransferIntent,options:NativeWriteOptions={}):Promise<NativeClaimSubmission>{
  const encoded=transferIntentToScVal(input);return this.lifecycle("accept_transfer_with_destination",input.context,input.to,encoded,input.label,initialization(input.resolver,input.label,input.to,input.expectedGeneration+1n,input.destination),options);
 }
 async renewName(input:RenewIntent,options:NativeWriteOptions={}):Promise<NativeClaimSubmission>{return this.lifecycle("renew_holder",input.context,input.holder,renewIntentToScVal(input),input.label,null,options);}
 private async lifecycle(method:"accept_transfer_with_destination"|"renew_holder",request:RequestContext,holder:string,intent:xdr.ScVal,nameLabel:string,child:NativeInvocation|null,options:NativeWriteOptions):Promise<NativeClaimSubmission>{
  request={...request};scoped(this.context,request);return this.context.serialize(async()=>{await verifyRegistrarProvenance(this.context,request.registrar,request.namespace);if(await this.context.read(this.context.registryId,"registrar_of",[sc.bytes(unhex(request.namespace))])!==request.registrar)throw new NativeClaimError("recovery Registrar is not the Registry attestation","unavailable");const old=await this.receiptAt(request.registrar,holder,request.requestId);if(old){receiptMatches(old,method,intent,holder);return{status:"replayed",receipt:old,transaction:null};}await this.checkRegistrar(request.registrar,request.namespace);if(child){const pair=await this.context.read(this.context.registryId,"native_contracts",[sc.bytes(unhex(request.namespace))]);if(!Array.isArray(pair)||pair.length!==2||pair[0]!==request.registrar||pair[1]!==child.contract)throw new NativeClaimError("transfer initializer differs from clean native bindings","unavailable");}const source=address(await this.context.signer.publicKey(),"account","holder source");if(source!==holder)throw new NativeClaimError("connected wallet is not the intended holder/recipient","authorization");
   const result=await sendNative(this.context,{source,contract:request.registrar,method,args:[intent],sourceInvocation:{contract:request.registrar,method,args:[intent],children:child?[child]:[]},maxFeeStroops:this.context.maxFeeStroops},options);return confirmedResult(result,method,intent,holder);});
 }
}
