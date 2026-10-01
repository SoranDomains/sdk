import assert from "node:assert/strict";
import test from "node:test";
import { Keypair } from "@stellar/stellar-sdk";
import { SoranHolder } from "@sorandomains/holder";
import { SoranOwner } from "@sorandomains/owner";
import { CONFIRMATION_EXEMPT, CONFIRMATION_REQUIRED, registerReadTools, registerWriteTools, toolAnnotations } from "../src/tools.js";
import { canonicalJson, createConfirmationGate } from "../src/confirm.js";

const payload = (result: any) => JSON.parse(result.content[0].text);
const WALLET = Keypair.random().publicKey(), OTHER = Keypair.random().publicKey(), THIRD = Keypair.random().publicKey();
const NETWORK = "Test SDF Network ; September 2015";
const key = new Uint8Array(32).fill(7);
function fake() {
  const handlers = new Map<string, (args: any) => Promise<any>>(), schemas = new Map<string, Record<string, any>>(), descriptions = new Map<string, string>();
  return { handlers, schemas, descriptions, server: { tool(name: string, description: string, schema: Record<string, any>, handler: any) { handlers.set(name, handler); schemas.set(name, schema); descriptions.set(name, description); } } };
}
async function withNoNetwork<T>(run: () => Promise<T>): Promise<T> {
  const saved = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error("no network expected"); }) as never;
  try { return await run(); } finally { globalThis.fetch = saved; }
}

test("the code is bound to the tool, every argument, the wallet and the network", () => {
  const gate = createConfirmationGate({ wallet: WALLET, network: NETWORK, key, now: () => 1_000_000 });
  const refusal = gate.check("set_payment", { name: "alice.nova", payment: { address: OTHER, memo: { type: "none" } } }, undefined)!;
  const { confirm, operation } = payload(refusal);
  assert.match(confirm, /^CONFIRM-[0-9a-f]{20}$/);
  assert.equal(gate.check("set_payment", operation, confirm), null);
  // Key order is irrelevant; every value is not.
  assert.equal(gate.check("set_payment", { payment: { memo: { type: "none" }, address: OTHER }, name: "alice.nova" }, confirm), null);
  for (const changed of [{ name: "bob.nova", payment: operation.payment }, { name: "alice.nova", payment: { address: THIRD, memo: { type: "none" } } },
    { name: "alice.nova", payment: { address: OTHER, memo: { type: "id", value: "1" } } }, { ...operation, extra: 1 }])
    assert.notEqual(gate.check("set_payment", changed, confirm), null, JSON.stringify(changed));
  assert.notEqual(gate.check("transfer_name", operation, confirm), null, "a code for one tool cannot confirm another");
  const otherWallet = createConfirmationGate({ wallet: OTHER, network: NETWORK, key, now: () => 1_000_000 });
  const otherNetwork = createConfirmationGate({ wallet: WALLET, network: "Public Global Stellar Network ; September 2015", key, now: () => 1_000_000 });
  const otherProcess = createConfirmationGate({ wallet: WALLET, network: NETWORK, key: new Uint8Array(32).fill(8), now: () => 1_000_000 });
  for (const foreign of [otherWallet, otherNetwork, otherProcess]) assert.notEqual(foreign.check("set_payment", operation, confirm), null);
});

test("literal or missing confirmations are refused, including the old CONFIRM and IRREVERSIBLE strings", () => {
  const gate = createConfirmationGate({ wallet: WALLET, network: NETWORK, key });
  for (const given of [undefined, "", "yes", "CONFIRM", "IRREVERSIBLE", "CONFIRM-", "CONFIRM-00000000000000000000", " ".repeat(5)]) {
    const refusal = gate.check("reclaim_name", { namespace: "nova", label: "alice" }, given);
    assert.equal(refusal?.isError, true, String(given));
    assert.match(payload(refusal).message, /^refusing: reclaim_name .*NOT executed/);
  }
  const permanent = payload(gate.check("make_permanent", { namespace: "nova" }, undefined, true)!);
  assert.match(permanent.confirm, /^IRREVERSIBLE-/); assert.match(permanent.message, /IRREVERSIBLE/);
  assert.notEqual(gate.check("make_permanent", { namespace: "nova" }, permanent.confirm.replace("IRREVERSIBLE", "CONFIRM"), true), null);
});

test("a code lives five to ten minutes and then must be re-issued", () => {
  let now = 10 * 300_000 + 1_000;
  const gate = createConfirmationGate({ wallet: WALLET, network: NETWORK, key, now: () => now });
  const op = { namespace: "nova", to: OTHER };
  const { confirm } = payload(gate.check("transfer_namespace", op, undefined)!);
  now += 60_000; assert.equal(gate.check("transfer_namespace", op, confirm), null);
  now = 11 * 300_000 + 299_000; assert.equal(gate.check("transfer_namespace", op, confirm), null, "still inside the following window");
  now = 12 * 300_000; assert.notEqual(gate.check("transfer_namespace", op, confirm), null, "expired");
  assert.notEqual(payload(gate.check("transfer_namespace", op, confirm)!).confirm, confirm);
});

test("canonical JSON is deterministic for nested keys, bigint and undefined", () => {
  assert.equal(canonicalJson({ b: 1n, a: { d: [3, { z: 1, y: undefined }], c: "x" } }), '{"a":{"c":"x","d":[3,{"z":1}]},"b":"1"}');
});

test("every write tool is either read-only, gated or exempt with a reason, and gated tools are annotated destructive", async () => {
  const f = fake();
  registerReadTools(f.server as never);
  await registerWriteTools(f.server as never, { secret: Keypair.random().secret() });
  const gated = [...CONFIRMATION_REQUIRED], exempt = Object.keys(CONFIRMATION_EXEMPT);
  assert.deepEqual(gated.filter(name => exempt.includes(name)), [], "a tool cannot be both gated and exempt");
  for (const name of f.handlers.keys()) {
    const readOnly = toolAnnotations(name).readOnlyHint;
    assert.ok(readOnly || CONFIRMATION_REQUIRED.has(name) || name in CONFIRMATION_EXEMPT, `${name} is a write tool with no confirmation decision`);
    if (readOnly) assert.ok(!CONFIRMATION_REQUIRED.has(name) && !(name in CONFIRMATION_EXEMPT), `${name} is read-only but classified as a write`);
  }
  for (const name of [...gated, ...exempt]) assert.ok(f.handlers.has(name), `${name} is classified but not a registered tool`);
  for (const name of gated) {
    assert.equal(toolAnnotations(name).destructiveHint, true, name);
    assert.ok("confirm" in f.schemas.get(name)!, `${name} takes a confirm`);
    assert.match(f.descriptions.get(name)!, /REQUIRES HUMAN CONFIRMATION/, name);
    assert.equal(f.schemas.get(name)!.confirm.isOptional(), true, name);
  }
  for (const name of exempt) assert.ok(!("confirm" in f.schemas.get(name)!), `${name} is exempt and takes no confirm`);
  for (const reason of Object.values(CONFIRMATION_EXEMPT)) assert.ok(reason.length > 20);
  assert.equal(gated.length + exempt.length + [...f.handlers.keys()].filter(name => toolAnnotations(name).readOnlyHint).length, f.handlers.size);
});

/** Arguments that pass each gated tool's schema (only the first, refused call is made against them). */
const samples: Record<string, Record<string, unknown>> = {
  claim_namespace: { label: "acme", expectedFee: { allocatorId: "C".padEnd(56, "A"), token: "C".padEnd(56, "B"), amount: "50000000000", recipient: OTHER, network: NETWORK }, maxNetworkFeeStroops: "1000000" },
  withdraw_claim: { label: "acme", maxNetworkFeeStroops: "1000000" },
  claim_username: { intentJson: "{}" },
  activate_namespace: { namespace: "acme", maxNetworkFeeStroops: "1000000" },
  deploy_namespace_resolver: { namespace: "acme", maxNetworkFeeStroops: "1000000" },
  issue_name: { namespace: "acme", label: "alice", holder: OTHER },
  issue_batch: { namespace: "acme", entries: [{ label: "alice", holder: OTHER }] },
  reclaim_name: { namespace: "acme", label: "alice" },
  set_treasury: { namespace: "acme", treasury: OTHER },
  set_resolver: { namespace: "acme", resolver: null },
  make_permanent: { namespace: "acme" },
  transfer_namespace: { namespace: "acme", to: OTHER },
  accept_namespace_transfer: { namespace: "acme" },
  configure_native_claims: { namespace: "acme", settings: { mode: "public", enabled: true, admission: { type: "open" }, feeToken: OTHER, feeAmount: "10", feeRecipient: OTHER, walletLimit: "1", approvalAllowance: "0", approvalRateLimit: "0", approvalWindowSecs: "0", approvalTtlSecs: "0" } },
  set_native_claims_enabled: { namespace: "acme", enabled: false },
  reserve_usernames: { namespace: "acme", labels: ["alice"], reserved: true },
  assign_reserved_username: { namespace: "acme", label: "alice", holder: OTHER },
  set_payment: { name: "alice.acme", payment: { address: OTHER, memo: { type: "none" } } },
  set_record: { name: "alice.acme", address: OTHER },
  transfer_name: { name: "alice.acme", to: OTHER },
  accept_name_transfer: { name: "alice.acme" },
  accept_name_transfer_with_destination: { intentJson: "{}" },
};

test("each gated tool refuses its first call, does nothing, and names the exact operation it would run", async () => {
  const f = fake();
  await withNoNetwork(async () => {
    await registerWriteTools(f.server as never, { secret: Keypair.random().secret() });
    assert.deepEqual(Object.keys(samples).sort(), [...CONFIRMATION_REQUIRED].sort(), "a sample is needed for every gated tool");
    for (const [name, args] of Object.entries(samples)) {
      const result = await f.handlers.get(name)!(args);
      assert.equal(result.isError, true, name);
      const body = payload(result);
      assert.equal(body.error, "ConfirmationRequired", name);
      assert.match(body.confirm, name === "make_permanent" ? /^IRREVERSIBLE-/ : /^CONFIRM-/);
      assert.deepEqual(body.operation, JSON.parse(JSON.stringify(args)), name);
      assert.equal(body.tool, name); assert.equal(body.network, NETWORK);
      // Wrong, static and cross-tool codes are refused too.
      const flipped = body.confirm.slice(0, -1) + (body.confirm.endsWith("0") ? "1" : "0");
      for (const confirm of ["CONFIRM", "IRREVERSIBLE", "yes", flipped])
        assert.equal(payload(await f.handlers.get(name)!({ ...args, confirm })).error, "ConfirmationRequired", `${name} ${confirm}`);
    }
  });
});

test("the exact code lets the call through once, and only for the same arguments (owner and holder tools)", async () => {
  const f = fake();
  const originalPayment = SoranHolder.prototype.setPayment, originalReclaim = SoranOwner.prototype.reclaim, originalTransfer = SoranHolder.prototype.proposeNameTransfer;
  const ran: string[] = [];
  SoranHolder.prototype.setPayment = async function (name: string, payment: any) { ran.push(`setPayment ${name} ${payment.address}`); return { ok: true } as never; };
  SoranOwner.prototype.reclaim = async function (ns: string, label: string) { ran.push(`reclaim ${ns} ${label}`); return { ok: true } as never; };
  SoranHolder.prototype.proposeNameTransfer = async function (name: string, to: string) { ran.push(`transfer ${name} ${to}`); return { ok: true } as never; };
  try {
    await withNoNetwork(async () => {
      await registerWriteTools(f.server as never, { secret: Keypair.random().secret() });
      const call = (name: string, args: Record<string, unknown>) => f.handlers.get(name)!(args);
      const pay = { name: "alice.acme", payment: { address: OTHER, memo: { type: "none" } } };
      const { confirm } = payload(await call("set_payment", pay));
      // A code obtained for one destination cannot be replayed for another.
      assert.equal(payload(await call("set_payment", { ...pay, payment: { address: THIRD, memo: { type: "none" } }, confirm })).error, "ConfirmationRequired");
      assert.deepEqual(ran, []);
      const done = await call("set_payment", { ...pay, confirm });
      assert.equal(done.isError, undefined); assert.deepEqual(ran, [`setPayment alice.acme ${OTHER}`]);
      // The handler receives the operation without the confirm field.
      const reclaim = { namespace: "acme", label: "alice" };
      const { confirm: reclaimCode } = payload(await call("reclaim_name", reclaim));
      assert.equal((await call("reclaim_name", { ...reclaim, confirm: reclaimCode })).isError, undefined);
      const transfer = { name: "alice.acme", to: OTHER };
      assert.equal(payload(await call("transfer_name", { ...transfer, confirm: reclaimCode })).error, "ConfirmationRequired");
      assert.equal((await call("transfer_name", { ...transfer, confirm: payload(await call("transfer_name", transfer)).confirm })).isError, undefined);
      assert.deepEqual(ran, [`setPayment alice.acme ${OTHER}`, "reclaim acme alice", `transfer alice.acme ${OTHER}`]);
    });
  } finally {
    SoranHolder.prototype.setPayment = originalPayment; SoranOwner.prototype.reclaim = originalReclaim; SoranHolder.prototype.proposeNameTransfer = originalTransfer;
  }
});

test("codes are per process and per wallet: a code from another server instance is useless", async () => {
  const a = fake(), b = fake();
  await withNoNetwork(async () => {
    await registerWriteTools(a.server as never, { secret: Keypair.random().secret() });
    await registerWriteTools(b.server as never, { secret: Keypair.random().secret() });
    const args = { namespace: "acme", label: "alice" };
    const { confirm } = payload(await a.handlers.get("reclaim_name")!(args));
    assert.equal(payload(await b.handlers.get("reclaim_name")!({ ...args, confirm })).error, "ConfirmationRequired");
  });
});

test("requireConfirmation:false removes the gate for hosts that add their own per-call approval", async () => {
  const f = fake();
  const original = SoranOwner.prototype.reclaim;
  let ran = 0;
  SoranOwner.prototype.reclaim = async function () { ran++; return { ok: true } as never; };
  try {
    await registerWriteTools(f.server as never, { secret: Keypair.random().secret(), requireConfirmation: false });
    assert.equal((await f.handlers.get("reclaim_name")!({ namespace: "acme", label: "alice" })).isError, undefined);
    assert.equal(ran, 1); assert.ok(!("confirm" in f.schemas.get("reclaim_name")!));
  } finally { SoranOwner.prototype.reclaim = original; }
});
