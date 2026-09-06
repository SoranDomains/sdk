import { hash, scValToNative, StrKey, xdr } from "@stellar/stellar-sdk";
import { NativeClaimError, address, hex, utf8 } from "./native-codec.js";
import { signEligibilityAuthorization, type EligibilitySigner } from "./native-auth.js";
import { claimIntentToScVal, type ClaimIntent, type ClaimConfig } from "./native-types.js";
export type ClaimApprovalContext = {
 /** Read this configuration and owner independently from the chain. Do not accept these from an applicant. */
 config: ClaimConfig; owner: string; ownerEpoch: bigint; networkPassphrase: string;
 /** Independently pinned/read deployment, never copied from the applicant intent. network/namespace are hex32. */
 network: string; registry: string; registrar: string; namespace: string; resolver: string;
 latestLedger: number; maxExpirationLedger: number; expirationLedger: number;
};
/** Backend admission signing only. The application must first authenticate membership and the wallet binding.
 * This function cannot turn an owner/treasury key into the configured admission account. */
export async function signClaimEligibility(intent:ClaimIntent,unsignedEntryXdr:string,context:ClaimApprovalContext,signer:EligibilitySigner):Promise<string>{
 const encoded=claimIntentToScVal(intent),config=context.config,settings=config.settings;
 if(context.network!==hex(hash(utf8(context.networkPassphrase)))||intent.context.network!==context.network||intent.context.registry!==context.registry||intent.context.registrar!==context.registrar||intent.context.namespace!==context.namespace||intent.resolver!==context.resolver||intent.ownerEpoch!==context.ownerEpoch||config.ownerEpoch!==context.ownerEpoch)throw new NativeClaimError("approval intent differs from trusted deployment, namespace or current ownership epoch","authorization");
 address(context.owner,"identity","namespace owner");
 if(settings.mode!=="public"||!settings.enabled||settings.admission.type!=="approval")throw new NativeClaimError("native app approval is not enabled","authorization");
 const account=settings.admission.account;
 if(account===context.owner||account===settings.feeRecipient||account===intent.claimant)throw new NativeClaimError("eligibility account must be separate from owner, treasury and claimant","authorization");
 if(intent.context.network!==hex(hash(utf8(context.networkPassphrase)))||intent.ownerEpoch!==config.ownerEpoch||intent.policyVersion!==config.policyVersion||intent.grantEpoch!==config.grantEpoch||intent.feeToken!==settings.feeToken||intent.feeAmount!==settings.feeAmount||intent.feeRecipient!==settings.feeRecipient)throw new NativeClaimError("approval intent differs from independently read network/policy","authorization");
 if(intent.context.deadline-intent.context.validAfter>settings.approvalTtlSecs)throw new NativeClaimError("approval exceeds the current business lifetime","authorization");
 const expected={account,invocation:{contract:intent.context.registrar,method:"claim",args:[encoded]},latestLedger:context.latestLedger,maxExpirationLedger:context.maxExpirationLedger};
 const signed=await signEligibilityAuthorization(xdr.SorobanAuthorizationEntry.fromXDR(unsignedEntryXdr,"base64"),expected,signer,context.expirationLedger,context.networkPassphrase);
 if(signed.credentials.type!=="sorobanCredentialsAddress")throw new NativeClaimError("unsupported approval credential","authorization");
 const signatures=scValToNative(signed.credentials.address.signature);
 if(!Array.isArray(signatures)||signatures.length===0)throw new NativeClaimError("approval is missing native account signatures","authorization");
 for(const signature of signatures){if(!(signature?.public_key instanceof Uint8Array)||signature.public_key.length!==32)throw new NativeClaimError("invalid native approval signer","authorization");const key=StrKey.encodeEd25519PublicKey(signature.public_key);if([context.owner,settings.feeRecipient,intent.claimant].includes(key))throw new NativeClaimError("owner, treasury and claimant keys must never sign app eligibility","authorization");}
 return signed.toXDR("base64");
}
