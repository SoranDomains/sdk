import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { Account, Address, Keypair, SorobanDataBuilder, StrKey, TransactionBuilder, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { SoranOwner } from "../src/index.js";

// (SR-01 / SW-05) Default-deny for every owner write. A Registrar is upgradeable by whoever owned the namespace
// before the current owner, so the callee an owner signs against is not a safe assumption: a host-recorded
// `token.transfer(owner -> attacker)` child call must never be signed. These tests run the REAL SDK pipeline
// (simulate -> assemble -> validators -> sign -> send) with only the RPC transport replaced, over every writer.

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
  const nsNode = nodeOf(NS), nameNode = nodeOf(`${LABEL}.${NS}`);
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
  const WRITES = new Set(["issue", "issue_batch", "reclaim", "renew", "set_treasury", "make_permanent", "propose_transfer",
    "accept_transfer", "cancel_transfer", "set_resolver", "set_chain_policy", "set_subname_policy"]);
  const sent: Sent[] = [];
  let signatures = 0;
  let lastReturn: xdr.ScVal = xdr.ScVal.scvVoid();
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
      const entry = new xdr.SorobanAuthorizationEntry({
        credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(), rootInvocation: inv(call(c, fn, args), subs),
      });
      lastReturn = fn === "issue" ? bytes(nameNode) : fn === "issue_batch" ? u32(0) : fn === "renew" ? u64(1n) : xdr.ScVal.scvVoid();
      // "extra": the honest root PLUS a second top-level entry that authorizes a transfer on its own.
      const second = new xdr.SorobanAuthorizationEntry({
        credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
        rootInvocation: inv(call(ids.token, "transfer", [addr(tx.source), addr(ids.attacker), nativeToScVal(1_000_000_000n, { type: "i128" })])),
      });
      return ok(lastReturn, mode === "extra" ? [entry, second] : [entry]);
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
    getTransaction: async () => ({ status: "SUCCESS", ledger: 101, returnValue: lastReturn }),
    getContractInstance: async () => { throw new Error("native path not modelled"); },
    getLedgerEntries: async () => ({ entries: [], latestLedger: 100 }),
  };
  const holder: any = new SoranOwner({
    signer: {
      publicKey: () => who,
      signTransaction: async (x: string, { networkPassphrase }: { networkPassphrase: string }) => {
        signatures++;
        const tx: any = TransactionBuilder.fromXDR(x, networkPassphrase);
        tx.sign(key);
        return tx.toXDR();
      },
    },
    registryId: ids.registry, rpcUrl: "https://soroban-testnet.stellar.org",
  });
  Object.assign(holder, { server });
  return { owner: holder, sent, signatures: () => signatures };
}

const other = G(3);
const WRITERS: Array<[string, (o: any) => Promise<unknown>, string]> = [
  ["issue", o => o.issue(NS, "bob", other), "issue"],
  ["issueBatch", o => o.issueBatch(NS, [{ label: "bob", holder: other }]), "issue_batch"],
  ["reclaim", o => o.reclaim(NS, "bob"), "reclaim"],
  ["renew", o => o.renew(NS, "bob", 86400), "renew"],
  ["setTreasury", o => o.setTreasury(NS, other), "set_treasury"],
  ["makePermanent", o => o.makePermanent(NS, { confirmIrreversible: true }), "make_permanent"],
  ["proposeNamespaceTransfer", o => o.proposeNamespaceTransfer(NS, other), "propose_transfer"],
  ["acceptNamespaceTransfer", o => o.acceptNamespaceTransfer(NS), "accept_transfer"],
  ["cancelNamespaceTransfer", o => o.cancelNamespaceTransfer(NS), "cancel_transfer"],
  ["setResolver", o => o.setResolver(NS, C(77)), "set_resolver"],
  ["setChainPolicy", o => o.setChainPolicy(NS, ["base"]), "set_chain_policy"],
  ["setSubnamePolicy", o => o.setSubnamePolicy(NS, "suspended"), "set_subname_policy"],
];

for (const [method, run, fn] of WRITERS) {
  test(`${method}: the honest single-call tree is signed and sent unchanged`, async () => {
    const r = rig("clean");
    await run(r.owner);
    const last = r.sent.at(-1);
    assert.ok(last, `${method} was not submitted`);
    assert.equal(last.fn, fn);
    assert.deepEqual(last.subs, [], "no nested authorization is signed on an honest write");
    assert.ok(last.credentials.every(c => c === "sorobanCredentialsSourceAccount"));
  });

  test(`${method}: a nested authorization recorded by the host is refused before anything is signed`, async () => {
    const r = rig("hostile");
    await assert.rejects(run(r.owner), /selected intent|exactly the source owner authorization/);
    assert.equal(r.signatures(), 0, "nothing may be signed");
    assert.equal(r.sent.length, 0, "nothing may be submitted");
  });

  test(`${method}: a second top-level authorization entry is refused before anything is signed`, async () => {
    const r = rig("extra");
    await assert.rejects(run(r.owner), /selected intent|exactly the source owner authorization/);
    assert.equal(r.signatures(), 0, "nothing may be signed");
    assert.equal(r.sent.length, 0, "nothing may be submitted");
  });
}
