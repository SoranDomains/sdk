import assert from "node:assert/strict";
import test from "node:test";
import { StrKey, hash, nativeToScVal, scValToNative, xdr } from "@stellar/stellar-sdk";
import { Soran, SoranError, DEPLOYMENTS, encodeChainAddress } from "../src/index.js";
const RESOLVER = StrKey.encodeContract(new Uint8Array(32).fill(1));
const REGISTRAR = StrKey.encodeContract(new Uint8Array(32).fill(2));
const REGISTRY = DEPLOYMENTS.testnet.registryId, LOOKUP = DEPLOYMENTS.testnet.lookupId;
const nsNode = new Uint8Array(hash(Uint8Array.from([...new Uint8Array(32), ...hash(new TextEncoder().encode("solo"))])));
const address = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
function client(direct = false, overrides: Record<string, unknown> = {}) {
  const s = new Soran(direct ? { resolutionMode: "direct" } : {});
  const calls: Array<[string,string,unknown[]]> = [];
  Object.assign(s, { read: async (id: string, fn: string, args: unknown[]) => {
    calls.push([id,fn,args.map(arg=>scValToNative(arg as never))]);
    if (Object.hasOwn(overrides,fn)) { const value=overrides[fn];if(value instanceof Error)throw value;return value; }
    if(fn==="registry")return REGISTRY;if(fn==="version")return 2;if(fn==="destination_version")return 2;
    if(fn==="multichain_version")return 1;if(fn==="resolver_of")return RESOLVER;if(fn==="registrar_of")return REGISTRAR;
    if(fn==="authority")return REGISTRAR;if(fn==="anchors")return [REGISTRY,nsNode];
    if(fn==="chain_policy")return [60,0,2147492101];if(fn==="chain_address")return encodeChainAddress("ethereum",address);
    throw new Error(`unexpected ${fn}`);
  } });return {s,calls};
}
for(const direct of [false,true])test(`chain lookup uses explicit native ${direct?"Resolver":"Lookup"} path and u32 network`,async()=>{
  const {s,calls}=client(direct);
  assert.equal(await s.chainAddress("FRED.SOLO","base"),address);
  assert.deepEqual(await s.chainPolicy("SOLO"),["ethereum","bitcoin","base"]);
  const read=calls.find(c=>c[1]==="chain_address")!;
  assert.equal(read[0],direct?RESOLVER:LOOKUP);assert.deepEqual(read[2],["fred.solo",2147492101]);
  assert.equal(calls.some(c=>["text","addr","resolve","resolve_payment"].includes(c[1])),false);
  for(const policyCall of calls.filter(c=>c[1]==="chain_policy"))assert.deepEqual(policyCall[2],direct?[]:["solo"]);
});
test("missing, disabled, unsupported, malformed, and unavailable stay distinct",async()=>{
  assert.equal(await client(false,{chain_address:null}).s.chainAddress("fred.solo","ethereum"),null);
  for(const direct of [false,true]){
    await assert.rejects(client(direct,{chain_policy:[]}).s.chainAddress("fred.solo","ethereum"),(e:unknown)=>e instanceof SoranError&&e.code==="CHAIN_DISABLED");
    for(const version of [0,2,1n,"1",null])await assert.rejects(client(direct,{multichain_version:version}).s.chainAddress("fred.solo","ethereum"),(e:unknown)=>e instanceof SoranError&&e.code==="MULTICHAIN_UNSUPPORTED");
    for(const raw of [undefined,"0x123",[],new Uint8Array(20)])await assert.rejects(client(direct,{chain_address:raw}).s.chainAddress("fred.solo","ethereum"),(e:unknown)=>e instanceof SoranError&&e.code==="ABI");
    for(const policy of [undefined,[60,60],["60"],[60n],[99]])await assert.rejects(client(direct,{chain_policy:policy}).s.chainPolicy("solo"),(e:unknown)=>e instanceof SoranError&&e.code==="ABI");
    const failure=new SoranError("archived","ARCHIVED");await assert.rejects(client(direct,{chain_address:failure}).s.chainAddress("fred.solo","ethereum"),e=>e===failure);
  }
  await assert.rejects(client().s.chainAddress("fred.solo","stellar" as never),(e:unknown)=>e instanceof SoranError&&e.code==="UNSUPPORTED_NETWORK");
});
test("direct mode rejects changed native wiring and reads policy freshly",async()=>{
  for(const overrides of [{resolver_of:null},{registrar_of:null},{registry:RESOLVER},{authority:RESOLVER},{anchors:[RESOLVER,nsNode]},{anchors:[REGISTRY,new Uint8Array(32)]}])
    await assert.rejects(client(true,overrides).s.chainAddress("fred.solo","ethereum"));
  const overrides={chain_policy:[60]};const {s}=client(true,overrides);
  assert.equal(await s.chainAddress("fred.solo","ethereum"),address);
  overrides.chain_policy=[];
  await assert.rejects(s.chainAddress("fred.solo","ethereum"),(e:unknown)=>e instanceof SoranError&&e.code==="CHAIN_DISABLED");
});
test("real transport decodes chain disable races for universal and direct resolution",async()=>{
  for(const direct of [false,true]){
    const s=new Soran(direct?{resolutionMode:"direct"}:{});
    Object.assign(s,{multichainContext:async()=>({id:direct?RESOLVER:LOOKUP,universal:!direct}),server:{simulateTransaction:async(tx: any)=>{
      const fn=tx.operations[0].func.invokeContract.functionName.toString();
      if(fn==="chain_policy")return {result:{retval:xdr.ScVal.scvVec([nativeToScVal(60,{type:"u32"})])},transactionData:{},events:[]};
      return {error:`Error(Contract, #${direct?34:30})`};
    }}});
    await assert.rejects(s.chainAddress("fred.solo","ethereum"),(e:unknown)=>e instanceof SoranError&&e.code==="CHAIN_DISABLED"&&e.contractError==="ChainDisabled");
  }
});
