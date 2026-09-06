import { hash, xdr } from "@stellar/stellar-sdk";
import { NativeClaimError, address, hex, hex32, sc, unhex } from "./native-codec.js";
export type ClaimAllowlistContext = { network: string; registry: string; namespace: string; registrar: string };
export type ClaimAllowlistBundle = { version: 1; context: ClaimAllowlistContext; root: string; entries: Array<{ account: string; leaf: string; proof: string[] }> };
export function claimAllowlistLeaf(context:ClaimAllowlistContext,account:string):string{
 return hex(hash(xdr.ScVal.scvVec([sc.symbol("allow_v1"),sc.bytes(unhex(context.network)),sc.address(address(context.registry,"contract","Registry")),sc.bytes(unhex(context.namespace)),sc.address(address(context.registrar,"contract","Registrar")),sc.address(address(account,"account","allowlisted claimant"))]).toXDR()));
}
export function claimAllowlistParent(left:string,right:string):string{hex32(left,"left leaf");hex32(right,"right leaf");const [first,second]=left<right?[left,right]:[right,left];const bytes=new Uint8Array(65);bytes[0]=1;bytes.set(unhex(first),1);bytes.set(unhex(second),33);return hex(hash(bytes));}
/** A complete list is required to generate a replacement root. Keep/distribute the returned proof bundle. */
export function buildClaimAllowlist(context:ClaimAllowlistContext,accounts:readonly string[]):ClaimAllowlistBundle{
 if(!Array.isArray(accounts)||accounts.length===0||accounts.length>65536)throw new NativeClaimError("allowlist requires 1–65536 distinct G accounts");
 const unique=new Set<string>();const entries=accounts.map(account=>{address(account,"account","allowlisted claimant");if(unique.has(account))throw new NativeClaimError("duplicate allowlist account");unique.add(account);return{account,leaf:claimAllowlistLeaf(context,account),proof:[] as string[]};}).sort((a,b)=>a.leaf.localeCompare(b.leaf));
 let layer=entries.map((entry,index)=>({hash:entry.leaf,indices:[index]}));
 while(layer.length>1){const next:typeof layer=[];for(let i=0;i<layer.length;i+=2){const left=layer[i],right=layer[i+1];if(!right){next.push(left);continue;}for(const index of left.indices)entries[index].proof.push(right.hash);for(const index of right.indices)entries[index].proof.push(left.hash);next.push({hash:claimAllowlistParent(left.hash,right.hash),indices:[...left.indices,...right.indices]});}layer=next;}
 return{version:1,context:{...context},root:layer[0].hash,entries};
}
export function verifyClaimAllowlistProof(context:ClaimAllowlistContext,account:string,proof:readonly string[],root:string):boolean{hex32(root,"allowlist root");if(!Array.isArray(proof)||proof.length>32)throw new NativeClaimError("allowlist proof exceeds 32 siblings");return proof.reduce(claimAllowlistParent,claimAllowlistLeaf(context,account))===root;}
