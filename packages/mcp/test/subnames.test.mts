import assert from "node:assert/strict";
import test from "node:test";
import { Keypair, StrKey, scValToNative } from "@stellar/stellar-sdk";
import { DEPLOYMENTS, Soran, SoranError, encodeMuxedAddress } from "@sorandomains/lookup";
import { HolderError, SoranHolder } from "@sorandomains/holder";
import { z } from "zod";
import { registerReadTools, registerWriteTools } from "../src/tools.js";

const key = Keypair.fromRawEd25519Seed(new Uint8Array(32).fill(81));
const wallet = key.publicKey(), other = Keypair.fromRawEd25519Seed(new Uint8Array(32).fill(82)).publicKey();
const child = "mail.alice.nova";
const resolver = StrKey.encodeContract(new Uint8Array(32).fill(83));
const registrar = StrKey.encodeContract(new Uint8Array(32).fill(84));
const payload = (result: any) => JSON.parse(result.content[0].text);

function server() {
  const tools = new Map<string, { schema: z.ZodRawShape; run: (args: any) => Promise<any> }>();
  return {
    tools,
    server: { tool(name: string, _description: string, schema: z.ZodRawShape, run: (args: any) => Promise<any>) { tools.set(name, { schema, run }); } },
    async call(name: string, input: Record<string, unknown>) {
      const tool = tools.get(name)!;
      return tool.run(z.object(tool.schema).parse(input));
    },
  };
}

const readTools = ["lookup_name", "name_metadata", "resolve_payment", "verify_payment", "resolve_name", "verify_name", "lookup_identity", "name_history"];
const recordTools = ["set_profile", "set_payment", "set_record", "set_muxed_display_name", "claim_display_name"];
const parentTools = ["native_claim_quote", "native_renewal_preview", "transfer_name", "cancel_name_transfer", "pending_name_transfer", "accept_name_transfer"];

test("MCP accepts exactly one ASCII child level only on supported surfaces", async () => {
  const f = server();
  registerReadTools(f.server);
  await registerWriteTools(f.server, { secret: key.secret() });
  const longest = Array(3).fill("a".repeat(63)).join(".");
  for (const tool of [...readTools, ...recordTools]) {
    const schema = f.tools.get(tool)!.schema.name;
    assert.equal(schema.parse("MAIL.ALICE.NOVA"), child, tool);
    assert.equal(schema.parse(longest), longest, tool);
    assert.equal(schema.parse("ALICE.NOVA"), "alice.nova", tool);
    for (const invalid of ["a.mail.alice.nova", "mail..nova", "K.alice.nova", " mail.alice.nova", "mail.alice.nova.", `${"a".repeat(64)}.alice.nova`])
      assert.throws(() => schema.parse(invalid), undefined, `${tool}: ${invalid}`);
  }
  for (const tool of parentTools) {
    const schema = f.tools.get(tool)!.schema.name;
    assert.equal(schema.parse("ALICE.NOVA"), "alice.nova", tool);
    assert.throws(() => schema.parse(child), /label.namespace/, tool);
  }
  // Namespace/label based lifecycle tools also retain their single-label grammar.
  for (const tool of ["issue_name", "reclaim_name", "renew_name"])
    assert.throws(() => f.tools.get(tool)!.schema.label.parse("mail.alice"), undefined, tool);
});

test("MCP read callbacks preserve the full canonical child and surface failed chain proof", async () => {
  const originals = new Map<string, unknown>();
  const calls: Array<[string, string]> = [];
  const values: Record<string, unknown> = {
    lookup: { kind: "nativePayment", name: child }, nameMetadata: { name: child, generation: 9007199254740993n },
    resolvePayment: { address: other, memo: { type: "id", value: "9007199254740993" } }, verifyPayment: true,
    record: { name: child, address: other }, assurance: { trustworthy: false }, verify: true,
    identity: { name: child, holder: wallet, address: other }, history: { name: child, events: [] },
  };
  const prototype = Soran.prototype as any;
  try {
    for (const [method, value] of Object.entries(values)) {
      originals.set(method, prototype[method]);
      prototype[method] = async (name: string) => { calls.push([method, name]); return value; };
    }
    const f = server(); registerReadTools(f.server);
    for (const tool of readTools) {
      const result = await f.call(tool, { name: "MAIL.ALICE.NOVA", payment: values.resolvePayment, address: other });
      assert.equal(result.isError, undefined, tool);
    }
    assert.equal(calls.length, 9);
    assert.ok(calls.every(([, name]) => name === child));
    prototype.resolvePayment = async () => { throw new SoranError("subnames unsupported", "SUBNAMES_UNSUPPORTED"); };
    const failed = await f.call("resolve_payment", { name: child });
    assert.equal(failed.isError, true);
    assert.equal(payload(failed).code, "SUBNAMES_UNSUPPORTED");
    assert.equal(Object.hasOwn(payload(failed), "address"), false);
  } finally { for (const [method, original] of originals) prototype[method] = original; }
});

test("MCP child record writes retain the signing parent account, recursive node and selected destination", async () => {
  const prototype = SoranHolder.prototype as any;
  const saved = { read: prototype.read, invoke: prototype.invoke };
  const writes: Array<{ method: string; args: any[] }> = [];
  const namespaceNode = await new Soran().namehash("nova");
  const childNode = await new Soran().node(child);
  try {
    prototype.read = async (_id: string, method: string) => {
      const values: Record<string, unknown> = { registry: DEPLOYMENTS.testnet.registryId, resolver_of: resolver,
        registrar_of: registrar, authority: registrar, anchors: [DEPLOYMENTS.testnet.registryId, namespaceNode],
        payment_version: 2, destination_version: 2, subname_version: 1 };
      if (!Object.hasOwn(values, method)) throw new Error(`unexpected read: ${method}`);
      return values[method];
    };
    prototype.invoke = async (id: string, method: string, args: any[]) => {
      assert.equal(id, resolver);
      writes.push({ method, args: args.map(scValToNative) });
      return { hash: "fixture", ledger: 1 };
    };
    const f = server(); await registerWriteTools(f.server, { secret: key.secret(), requireConfirmation: false });
    const payment = { address: other, memo: { type: "id", value: "9007199254740993" } };
    for (const [tool, args] of [["set_payment", { payment }], ["set_record", { address: other }], ["set_profile", { profile: { url: "https://example.test" } }]] as const) {
      const result = await f.call(tool, { name: "MAIL.ALICE.NOVA", ...args });
      assert.equal(result.isError, undefined, result.content[0].text);
    }
    assert.deepEqual(writes, [
      { method: "set_payment", args: [child, wallet, other, ["Id", 9007199254740993n]] },
      { method: "set_addr", args: [childNode, wallet, other] },
      { method: "set_text", args: [childNode, wallet, "url", "https://example.test"] },
    ]);
    prototype.invoke = async () => { throw new HolderError("parent holder required", resolver, "set_payment", 3, "NotHolder"); };
    const rejected = await f.call("set_payment", { name: child, payment });
    assert.equal(rejected.isError, true);
    assert.match(payload(rejected).message, /parent holder required/);
    assert.equal(writes.length, 3, "no retry under the child destination's authority");
  } finally { Object.assign(prototype, saved); }
});

test("child payment confirmation cannot be reused for its parent or a sibling", async () => {
  const saved = SoranHolder.prototype.setPayment;
  const calls: string[] = [];
  try {
    SoranHolder.prototype.setPayment = async name => { calls.push(name); return { hash: "fixture", ledger: 1 }; };
    const f = server(); await registerWriteTools(f.server, { secret: key.secret() });
    const payment = { address: other, memo: { type: "none" } };
    const refusal = await f.call("set_payment", { name: "MAIL.ALICE.NOVA", payment });
    assert.equal(refusal.isError, true); assert.deepEqual(calls, []);
    const { confirm, operation } = payload(refusal); assert.equal(operation.name, child);
    for (const name of ["alice.nova", "other.alice.nova"])
      assert.equal((await f.call("set_payment", { name, payment, confirm })).isError, true);
    assert.deepEqual(calls, []);
    assert.equal((await f.call("set_payment", { name: child, payment, confirm })).isError, undefined);
    assert.deepEqual(calls, [child]);
  } finally { SoranHolder.prototype.setPayment = saved; }
});

test("child display elections preserve destination authority and stop before primary on failed proof", async () => {
  const holder = SoranHolder.prototype as any, lookup = Soran.prototype as any;
  const saved = { setReverse: holder.setReverse, setRecord: holder.setRecord, setPrimary: holder.setPrimary, read: holder.read, invoke: holder.invoke };
  const savedResolve = lookup.resolve;
  const calls: string[] = [];
  try {
    holder.setReverse = async (name: string) => { assert.equal(name, child); calls.push("reverse"); throw new HolderError("forward mismatch", resolver, "set_reverse", 1, "ForwardMismatch"); };
    holder.setRecord = async () => { calls.push("record"); throw new Error("must not overwrite another destination"); };
    holder.setPrimary = async () => { calls.push("primary"); throw new Error("must not elect without reverse proof"); };
    lookup.resolve = async (name: string) => { assert.equal(name, child); return other; };
    const f = server(); await registerWriteTools(f.server, { secret: key.secret() });
    const refused = await f.call("claim_display_name", { name: child });
    assert.equal(refused.isError, true); assert.match(payload(refused).message, /currently PAYS/);
    assert.deepEqual(calls, ["reverse"]);
    holder.setReverse = async () => { calls.push("reverse"); throw new HolderError("suspended", resolver, "set_reverse", 39, "SubnamesSuspended"); };
    assert.equal((await f.call("claim_display_name", { name: child })).isError, true);
    assert.deepEqual(calls, ["reverse", "reverse"]);

    holder.read = async (_id: string, method: string) => {
      const values: Record<string, unknown> = { subname_version: 1, registry: DEPLOYMENTS.testnet.registryId, version: 2, destination_version: 2, muxed_identity_version: 1 };
      if (!Object.hasOwn(values, method)) throw new Error(`unexpected read: ${method}`);
      return values[method];
    };
    const identityWrites: any[] = [];
    holder.invoke = async (_id: string, method: string, args: any[]) => {
      identityWrites.push([method, ...args.map(scValToNative)]);
      return { hash: "fixture", ledger: 1 };
    };
    for (const kind of ["reverse", "primary"]) {
      const invalid = await f.call("set_muxed_display_name", { name: child, destination: encodeMuxedAddress(other, "42"), kind });
      assert.equal(invalid.isError, true); assert.match(payload(invalid).message, /underlying G account must sign/);
      assert.deepEqual(identityWrites, []);
    }
    const destination = encodeMuxedAddress(wallet, "9007199254740993");
    for (const kind of ["reverse", "primary"])
      assert.equal((await f.call("set_muxed_display_name", { name: child, destination, kind })).isError, undefined);
    assert.deepEqual(identityWrites, [
      ["set_reverse_muxed", wallet, 9007199254740993n, child],
      ["set_primary_muxed", wallet, 9007199254740993n, child],
    ]);
  } finally { Object.assign(holder, saved); lookup.resolve = savedResolve; }
});
