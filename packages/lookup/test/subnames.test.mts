import assert from "node:assert/strict";
import test from "node:test";
import { hash, nativeToScVal, scValToNative, StrKey } from "@stellar/stellar-sdk";
import { Soran, SoranError, parseName, parseResolvableName } from "../src/index.js";
import { subnamePolicyFromNative, resolvableNameNode } from "../src/names.js";
import { nameStatusFromNative } from "../src/read-extensions.js";
const registrar=StrKey.encodeContract(new Uint8Array(32).fill(2)),holder=StrKey.encodeEd25519PublicKey(new Uint8Array(32).fill(3));
test("recursive node hashing and grammar distinguish child and parent without broadening registration",async()=>{
 const s=new Soran();const parent=await s.node("fred.solo"),joined=new Uint8Array(64);joined.set(parent);joined.set(hash(new TextEncoder().encode("mail")),32);
 assert.deepEqual(await s.node("MAIL.FRED.SOLO"),hash(joined));assert.equal(parseResolvableName("mail.fred.solo").namespace,"solo");assert.equal(parseResolvableName("mail.fred.solo").label,"mail.fred");assert.throws(()=>parseName("mail.fred.solo"));
 for(const name of ["a.b.c.d","mail..solo","m.K.solo"," mail.fred.solo","mail.fred.solo.",`${"a".repeat(64)}.fred.solo`])assert.throws(()=>parseResolvableName(name));
 assert.equal(parseResolvableName(`${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}`).name.length,191);
});
test("policy decoding rejects unknown or malformed variants",()=>{assert.equal(subnamePolicyFromNative(["CreationDisabled"]),"creation-disabled");for(const raw of ["Enabled",["Enabled",true],[],["Unknown"]])assert.throws(()=>subnamePolicyFromNative(raw));});
test("Suspended status is distinct from expired and cannot conceal an expired timestamp",()=>{
 const node=resolvableNameNode("mail.fred.solo"),hex=Array.from(node,b=>b.toString(16).padStart(2,"0")).join("");const raw={name:"mail.fred.solo",ledger:1,timestamp:50n,state:["Suspended",{registrar,node,holder,generation:7n,expires_at:100n}]};
 assert.equal(nameStatusFromNative(raw,raw.name,hex).state.kind,"suspended");assert.throws(()=>nameStatusFromNative({...raw,timestamp:101n},raw.name,hex));
});
test("universal resolution keeps full child name and fails closed on unsupported child capability",async()=>{
 const s=new Soran();const calls:any[]=[];Object.assign(s,{universalContext:async()=>({id:registrar,version:2}),read:async(id:string,fn:string,args:any[])=>{calls.push(fn);if(fn==="subname_version")return 1;return {name:"mail.fred.solo",registrar,resolver:registrar,generation:7n,result:["NativePayment",["Direct",{address:holder,memo:["None"]}]]};}});
 assert.equal((await s.resolvePayment("mail.fred.solo")).address,holder);assert.deepEqual(calls,["subname_version","resolve_v2"]);
 Object.assign(s,{read:async()=>0});await assert.rejects(s.resolvePayment("mail.fred.solo"),/subnames unsupported/);
});

for (const supported of [true, false]) test(`shared metadata reads preserve child capability checks: ${supported}`, async () => {
  const s = new Soran({ hintUrl: "https://hint.example" });
  const name = "mail.fred.solo", node = resolvableNameNode(name), calls: string[] = [];
  Object.assign(s, {
    universalContext: async () => ({ id: registrar, version: 2 }),
    read: async (_id: string, fn: string, args: any[]) => {
      calls.push(fn);
      if (fn === "subname_version") return supported ? 1 : 0;
      assert.equal(fn, "name_metadata");
      assert.equal(scValToNative(args[0]), name);
      return { name, node, registrar, holder, builtin_address: holder, generation: 7n,
        expires_at: 0n, active: true, no_expiry: true, namespace_permanent: true };
    },
    hintFetch: async () => ({ holder, names: [{ name }], nextCursor: null, hasMore: false,
      coverage: { source: "indexed", complete: true, processedLedger: 10, headLedger: 10, gaps: [] } }),
  });
  if (supported) assert.equal((await s.nameMetadata(name))?.name, name);
  else await assert.rejects(s.nameMetadata(name), /subnames unsupported/);
  const page = await s.namesOfPage(holder);
  assert.equal(page.names.length, supported ? 1 : 0);
  assert.equal(page.verification.failed, supported ? 0 : 1);
  assert.equal(page.complete, supported);
  assert.deepEqual(calls, supported
    ? ["subname_version", "name_metadata", "subname_version", "name_metadata"]
    : ["subname_version", "subname_version"]);
});

test("direct details and identity reject subnames before using the parent-only Registrar ABI", async () => {
  const s = new Soran({ resolutionMode: "direct" });
  let reads = 0;
  Object.assign(s, { read: async () => { reads++; throw new Error("unexpected chain read"); } });
  for (const query of [() => s.details("mail.fred.solo"), () => s.identity("mail.fred.solo")]) {
    await assert.rejects(query(), error => error instanceof SoranError && error.code === "CONFIG" && /Universal Lookup/.test(error.message));
  }
  assert.equal(reads, 0);
});
