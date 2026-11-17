import test from "node:test";
import assert from "node:assert/strict";
import { Keypair,StrKey,scValToNative } from "@stellar/stellar-sdk";
import { executionPolicyToScVal,executionApprovalFromNative,executionQuoteToScVal,type ExecutionPolicy } from "../src/funding-types.js";
const wallet=Keypair.random().publicKey();
const p:ExecutionPolicy={wallet,termsVersion:2,serviceFeeBps:500,payFailedFees:true,serviceFeeCap:100n,
  limits:{relayer:wallet,renewalCap:1000n,dailyCap:2000n,totalCap:3000n,retention:500000,renewBefore:100000,quoteLifetime:30,validUntil:9999999999n}};
test("prepaid custody and pricing terms are explicit, versioned and encoded exactly",()=>{
 const native=scValToNative(executionPolicyToScVal(p));
 assert.equal(native.wallet,wallet);assert.equal(native.service_fee_bps,500);assert.equal(native.pay_failed_fees,true);
 const a=executionApprovalFromNative({policy:native,deposited_total:123456789n,deposit_nonce:2n});assert.deepEqual(a.policy,p);assert.equal(a.depositedTotal,123456789n);
 for(const changed of [{serviceFeeBps:501},{termsVersion:1},{payFailedFees:false},{wallet:Keypair.random().publicKey()},{serviceFeeCap:-1n}])assert.throws(()=>executionPolicyToScVal({...p,...changed} as ExecutionPolicy));
});
test("prepaid quotes bind the network, funding contract, epoch-scoped position and network maximum without a second reimbursement",()=>{
 const c=(n:number)=>StrKey.encodeContract(new Uint8Array(32).fill(n));
 const q={network:"ab".repeat(32),funding:c(1),fundId:"cd".repeat(32),configRevision:1n,policyRevision:2n,nonce:3n,quoteId:"ef".repeat(32),
   maxNetworkFee:1000n,issuedLedger:100,expiresLedger:120,plan:{registrar:c(2),resolver:c(3),registrarKeys:[],resolverKeys:[]}};
 const n=scValToNative(executionQuoteToScVal(q));assert.equal(n.max_network_fee,1000n);assert(!("charge" in n));assert.equal(n.policy_revision,2n);
 assert.throws(()=>executionQuoteToScVal({...q,maxNetworkFee:0n}));assert.throws(()=>executionQuoteToScVal({...q,expiresLedger:221}));
});
