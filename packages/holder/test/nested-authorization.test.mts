import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { Account, Address, Keypair, SorobanDataBuilder, StrKey, TransactionBuilder, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { SoranHolder } from "../src/index.js";

// (SR-01) Default-deny for every G-account write. The registry accepts ANY address as a namespace's
// resolver, so a namespace owner can point a name at code that, when the holder writes a text record,
// asks the host to record `token.transfer(holder -> attacker)` under the holder's own authorization.
// An honest simulation then returns that child call and the SDK used to sign it for every write that
// was not on a short payment allow-list. These tests run the REAL SDK pipeline (simulate -> assemble ->
// validators -> sign -> send) with only the RPC transport replaced, over every legacy writer.

const NS = "solo", LABEL = "alice";
const sha = (b: Buffer) => createHash("sha256").update(b).digest();
const nodeOf = (name: string) => {
  let n: Buffer = Buffer.alloc(32);
  for (const p of name.split(".").reverse()) n = sha(Buffer.concat([n, sha(Buffer.from(p))]));
  return n;
};
const C = (n: number) => StrKey.encodeContract(Buffer.alloc(32, n));
const G = (n: number) => StrKey.encodeEd25519PublicKey(Buffer.alloc(32, n));
const ids = { registry: C(10), primary: C(12), lookup: C(13), registrar: C(14), resolver: C(15), token: C(7), attacker: G(9), other: G(3) };

type Mode = "clean" | "hostile" | "extra";
type Sent = { fn: string; subs: string[]; credentials: string[] };

function rig(mode: Mode) {
  const key = Keypair.random();
  const who = key.publicKey();
  const nsNode = nodeOf(NS);
  const addr = (a: string) => nativeToScVal(a, { type: "address" });
  const u32 = (n: number) => nativeToScVal(n, { type: "u32" });
  const u64 = (n: bigint) => nativeToScVal(n, { type: "u64" });
  const bytes = (b: Uint8Array) => nativeToScVal(Buffer.from(b), { type: "bytes" });
  const sym = (s: string) => xdr.ScVal.scvSymbol(s);
  const vec = (...v: xdr.ScVal[]) => xdr.ScVal.scvVec(v);
  const mapv = (o: Record<string, xdr.ScVal>) => xdr.ScVal.scvMap(Object.keys(o).sort().map(k => new xdr.ScMapEntry({ key: sym(k), val: o[k] })));
  const call = (c: string, fn: string, args: xdr.ScVal[]) => new xdr.InvokeContractArgs({ contractAddress: new Address(c).toScAddress(), functionName: fn, args });
  const inv = (c: xdr.InvokeContractArgs, subs: xdr.SorobanAuthorizedInvocation[] = []) => new xdr.SorobanAuthorizedInvocation({
    function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(c), subInvocations: subs,
  });
  const read = (c: string, fn: string): xdr.ScVal | undefined => {
    if (c === ids.registry) {
      if (fn === "owner_of") return addr(who);
      if (fn === "registrar_of") return addr(ids.registrar);
      if (fn === "resolver_of") return addr(ids.resolver);
      if (fn === "pending_transfer") return xdr.ScVal.scvVoid();
    }
    if (c === ids.registrar) {
      if (fn === "anchors") return vec(addr(ids.registry), bytes(nsNode));
      if (fn === "subname_version") return u32(1);
      if (fn === "subname_policy") return vec(sym("Enabled"));
      if (fn === "holder_and_generation") return vec(addr(who), u64(3n));
      if (fn === "subname_record") return xdr.ScVal.scvVoid();
      if (fn === "record_of") return mapv({ address: addr(who), expires_at: u64(0n), generation: u64(3n), holder: addr(who) });
      if (fn === "policy") return mapv({ default_term_secs: u64(0n), reclaimable: xdr.ScVal.scvBool(true), trade_fee_bps: u32(0), tradeable: xdr.ScVal.scvBool(false), transferable: xdr.ScVal.scvBool(true) });
      if (fn === "pending_transfer") return xdr.ScVal.scvVoid();
      if (fn === "claim_version") return u32(0);
      if (fn === "is_permanent") return xdr.ScVal.scvBool(false);
    }
    if (c === ids.resolver) {
      if (fn === "registry") return addr(ids.registry);
      if (fn === "authority") return addr(ids.registrar);
      if (fn === "payment_version" || fn === "destination_version") return u32(2);
      if (fn === "subname_version" || fn === "multichain_version") return u32(1);
      if (fn === "chain_policy") return vec(u32(2147492101), u32(0));
      if (fn === "resolve_destination") return vec(sym("Direct"), mapv({ address: addr(who), memo: vec(sym("None")) }));
    }
    if (c === ids.primary && fn === "registry") return addr(ids.registry);
    if (c === ids.lookup) {
      if (fn === "registry") return addr(ids.registry);
      if (fn === "version" || fn === "destination_version") return u32(2);
      if (fn === "muxed_identity_version") return u32(1);
    }
    return undefined;
  };
  const WRITES = new Set([
    "propose_transfer", "accept_transfer", "cancel_transfer", "set_payment", "set_muxed", "set_address", "set_addr", "set_text",
    "set_reverse", "clear_reverse", "set_primary", "clear_primary", "set_chain_address", "clear_chain_address", "create_subname",
    "remove_subname", "touch_subname", "touch_subname_page",
  ]);
  const PERMISSIONLESS = new Set(["touch_subname", "touch_subname_page"]);
  const sent: Sent[] = [];
  let signatures = 0;
  const ok = (retval: xdr.ScVal, auth: xdr.SorobanAuthorizationEntry[] = []) =>
    ({ _parsed: true, transactionData: new SorobanDataBuilder(), minResourceFee: "1000", result: { auth, retval }, events: [], latestLedger: 100 });
  const server = {
    getAccount: async (a: string) => new Account(a, "5"),
    getLatestLedger: async () => ({ id: "x", protocolVersion: 28, sequence: 100, closeTime: "0" }),
    simulateTransaction: async (tx: any) => {
      const ic = tx.operations[0].func.invokeContract;
      const c = Address.fromScAddress(ic.contractAddress).toString(), fn = ic.functionName.toString(), args = ic.args;
      if (!WRITES.has(fn)) {
        const v = read(c, fn);
        return v === undefined ? { _parsed: true, error: `unmodelled read ${fn}`, events: [], latestLedger: 100 } : ok(v);
      }
      const subs = mode === "hostile"
        ? [inv(call(ids.token, "transfer", [addr(tx.source), addr(ids.attacker), nativeToScVal(1_000_000_000n, { type: "i128" })]))]
        : [];
      // Permissionless upkeep takes no authorization on the honest contract; a hostile host may still invent one.
      if (PERMISSIONLESS.has(fn) && mode === "clean") return ok(xdr.ScVal.scvVoid(), []);
      const entry = new xdr.SorobanAuthorizationEntry({
        credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(), rootInvocation: inv(call(c, fn, args), subs),
      });
      // "extra": the honest root PLUS a second top-level entry that authorizes a transfer on its own.
      const second = new xdr.SorobanAuthorizationEntry({
        credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
        rootInvocation: inv(call(ids.token, "transfer", [addr(tx.source), addr(ids.attacker), nativeToScVal(1_000_000_000n, { type: "i128" })])),
      });
      return ok(xdr.ScVal.scvVoid(), mode === "extra" ? [entry, second] : [entry]);
    },
    sendTransaction: async (tx: any) => {
      const ic = tx.operations[0].func.invokeContract;
      const auth: xdr.SorobanAuthorizationEntry[] = tx.operations[0].auth ?? [];
      sent.push({
        fn: ic.functionName.toString(),
        subs: auth.flatMap(e => e.rootInvocation.subInvocations.map(s => s.function.contractFn.functionName.toString())),
        credentials: auth.map(e => e.credentials.type),
      });
      return { status: "PENDING", hash: Buffer.from(tx.hash()).toString("hex"), latestLedger: 100 };
    },
    getTransaction: async () => ({ status: "SUCCESS", ledger: 101, returnValue: xdr.ScVal.scvVoid() }),
    getContractInstance: async () => { throw new Error("native path not modelled"); },
    getLedgerEntries: async () => ({ entries: [], latestLedger: 100 }),
  };
  const holder: any = new SoranHolder({
    signer: {
      publicKey: () => who,
      signTransaction: async (x: string, { networkPassphrase }: { networkPassphrase: string }) => {
        signatures++;
        const tx: any = TransactionBuilder.fromXDR(x, networkPassphrase);
        tx.sign(key);
        return tx.toXDR();
      },
    },
    registryId: ids.registry, primaryId: ids.primary, lookupId: ids.lookup, rpcUrl: "https://soroban-testnet.stellar.org",
  });
  Object.assign(holder, { server });
  return { holder, sent, signatures: () => signatures };
}

const NAME = `${LABEL}.${NS}`, CHILD = `mail.${LABEL}.${NS}`;
const WRITERS: Array<[string, (h: any) => Promise<unknown>, string]> = [
  ["setText", h => h.setText(NAME, "url", "https://example.org"), "set_text"],
  ["clearText", h => h.clearText(NAME, "url"), "set_text"],
  ["setProfile", h => h.setProfile(NAME, { org: "Alice" }), "set_text"],
  ["setRecord", h => h.setRecord(NAME, ids.other), "set_addr"],
  ["setAddress", h => h.setAddress(NAME, ids.other), "set_address"],
  ["setReverse", h => h.setReverse(NAME), "set_reverse"],
  ["clearReverse", h => h.clearReverse(NS), "clear_reverse"],
  ["setPrimary", h => h.setPrimary(NAME), "set_primary"],
  ["clearPrimary", h => h.clearPrimary(), "clear_primary"],
  ["proposeNameTransfer", h => h.proposeNameTransfer(NAME, ids.other), "propose_transfer"],
  ["acceptNameTransfer", h => h.acceptNameTransfer(NAME), "accept_transfer"],
  ["cancelNameTransfer", h => h.cancelNameTransfer(NAME), "cancel_transfer"],
  ["setPayment", h => h.setPayment(NAME, { address: ids.other, memo: { type: "none" } }), "set_payment"],
  ["setChainAddress", h => h.setChainAddress(NAME, "base", "0x" + "ab".repeat(20)), "set_chain_address"],
  ["clearChainAddress", h => h.clearChainAddress(NAME, "base"), "clear_chain_address"],
  ["createSubname", h => h.createSubname(CHILD, ids.other, { parentGeneration: 3n, previousGeneration: null }), "create_subname"],
  ["removeSubname", h => h.removeSubname(CHILD, { parentGeneration: 3n, generation: 5n }), "remove_subname"],
  ["touchSubname", h => h.touchSubname(CHILD), "touch_subname"],
  ["touchSubnamePage", h => h.touchSubnamePage(NAME, 0), "touch_subname_page"],
];

for (const [method, run, fn] of WRITERS) {
  test(`${method}: the honest single-call tree is signed and sent unchanged`, async () => {
    const r = rig("clean");
    await run(r.holder);
    const last = r.sent.at(-1);
    assert.ok(last, `${method} was not submitted`);
    assert.equal(last.fn, fn);
    assert.deepEqual(last.subs, [], "no nested authorization is signed on an honest write");
    assert.ok(last.credentials.every(c => c === "sorobanCredentialsSourceAccount"));
  });

  test(`${method}: a nested authorization recorded by the host is refused before anything is signed`, async () => {
    const r = rig("hostile");
    await assert.rejects(run(r.holder), /selected intent|exactly the source holder authorization|must not require authorization/);
    assert.equal(r.signatures(), 0, "nothing may be signed");
    assert.equal(r.sent.length, 0, "nothing may be submitted");
  });

  test(`${method}: a second top-level authorization entry is refused before anything is signed`, async () => {
    const r = rig("extra");
    await assert.rejects(run(r.holder), /selected intent|exactly the source holder authorization|must not require authorization/);
    assert.equal(r.signatures(), 0, "nothing may be signed");
    assert.equal(r.sent.length, 0, "nothing may be submitted");
  });
}

test("permissionless upkeep must carry no authorization at all", async () => {
  // A host that invents a source-account entry for touch_subname_page / touch_subname is lying: the
  // entrypoints do not require auth, so the only reason to add one is to get a signature on it.
  for (const [method, run] of [["touchSubname", (h: any) => h.touchSubname(CHILD)], ["touchSubnamePage", (h: any) => h.touchSubnamePage(NAME, 0)]] as const) {
    const r = rig("hostile");
    await assert.rejects(run(r.holder), /must not require authorization/, method);
    assert.equal(r.signatures(), 0);
  }
});
