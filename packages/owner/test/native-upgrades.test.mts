import assert from "node:assert/strict";
import test from "node:test";
import { Account, Address, Keypair, SorobanDataBuilder, StrKey, TransactionBuilder, scValToNative, xdr } from "@stellar/stellar-sdk";
import { readFileSync } from "node:fs";
import { SoranOwner, CONTRACT_RELEASES, contractUpgradeDirection, type ContractUpgradeRole } from "../src/index.js";
import { authorizedInvocation } from "../src/native-auth.js";
import { hex, namespaceNode, sc, unhex } from "../src/native-codec.js";
import { instanceProof } from "./helpers/native-ledger.mjs";

const key = Keypair.random(), owner = key.publicKey(), other = Keypair.random().publicKey();
const C = (n: number) => StrKey.encodeContract(new Uint8Array(32).fill(n));
const registry = C(1), registrar = C(2), resolver = C(3), target = "ab".repeat(32);
const hashes = { registrar: "11".repeat(32), resolver: "22".repeat(32) };
type Options = {
  owner?: string; approved?: boolean; governed?: boolean; policy?: number;
  missingResolver?: boolean; wrongSelected?: boolean; tainted?: boolean; wrongExecutable?: ContractUpgradeRole;
  wrongAuthority?: boolean; wrongProvenance?: boolean; wrongAnchors?: boolean;
  nestedAuth?: boolean; extraAuth?: boolean; badWallet?: "mutate" | "unsigned" | "switch";
  resourceFee?: string; migrationActive?: boolean; interrupted?: boolean; rejection?: unknown;
  /** Hash the caller asks to install and the hashes currently installed (default: an unreviewed target over unrecognised current code). */
  target?: string; current?: Partial<Record<ContractUpgradeRole, string>>;
};
function fixture(options: Options = {}) {
  const wanted = options.target ?? target;
  const installed = { registrar: options.current?.registrar ?? hashes.registrar, resolver: options.current?.resolver ?? hashes.resolver };
  let signs = 0, sends = 0, simulated = 0, sentTx: any;
  const calls: string[] = [];
  const approvalRoles: number[] = [];
  const proof = instanceProof(registry);
  proof.entries[0].val.value.val.value.storage = options.governed === false ? [] : [new xdr.ScMapEntry({
    key: xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("AuthorityV1")]), val: new Address(owner).toScVal(),
  })];
  const client = new SoranOwner({ registryId: registry, signer: {
    publicKey: () => options.badWallet === "switch" && simulated ? other : owner,
    signTransaction: async (raw, { networkPassphrase }) => {
      signs++;
      let tx = TransactionBuilder.fromXDR(raw, networkPassphrase);
      if (options.badWallet === "mutate") tx = TransactionBuilder.cloneFrom(tx as any, { networkPassphrase, fee: "999" }).build();
      if (options.badWallet !== "unsigned") tx.sign(key);
      return tx.toXDR();
    },
  } });
  Object.assign(client, {
    read: async (id: string, method: string, args: xdr.ScVal[]) => {
      calls.push(`${id}:${method}`);
      if (id === registry) {
        switch (method) {
          case "native_contracts": return [registrar, options.missingResolver ? null : resolver];
          case "owner_of": return options.owner ?? owner;
          case "registrar_of": return registrar;
          case "attested_resolver_of": return options.missingResolver ? null : resolver;
          case "resolver_of": return options.wrongSelected ? C(9) : options.missingResolver ? null : resolver;
          case "registrar_tainted": return false;
          case "resolver_tainted": return options.tainted ?? false;
          case "upgrade_policy_version": return 1;
          case "native_code": return { registrar: unhex(installed.registrar), resolver: unhex(installed.resolver), registrar_updates: 2, resolver_updates: 1 };
          case "template_hashes": return [unhex(installed.registrar), unhex(installed.resolver)];
          case "implementation_approved": {
            assert.equal(hex(scValToNative(args[1])), wanted);
            approvalRoles.push(scValToNative(args[0]));
            return options.approved ?? true;
          }
        }
      }
      if (method === "upgrade_policy_version" && (id === registrar || id === resolver)) return options.policy ?? 1;
      if (id === registrar && method === "anchors") return [options.wrongAnchors ? C(9) : registry, namespaceNode("nova")];
      if (id === resolver && method === "provenance") return { registry, node: namespaceNode(options.wrongProvenance ? "other" : "nova") };
      if (id === resolver && method === "authority") return options.wrongAuthority ? C(9) : registrar;
      if (id === resolver && method === "registry") return registry;
      throw new Error("unexpected read (claim settings must not be needed): " + method);
    },
    server: {
      getLedgerEntries: async () => proof,
      getContractInstance: async (id: string) => {
        const role = id === registrar ? "registrar" : "resolver";
        return new xdr.ScContractInstance({ executable: xdr.ContractExecutable.contractExecutableWasm(options.wrongExecutable === role ? "ff".repeat(32) : installed[role]), storage: [] });
      },
      getAccount: async () => new Account(owner, "0"),
      simulateTransaction: async (tx: any) => {
        simulated++;
        if (options.migrationActive) return { _parsed: true, error: "Error(Contract, MigrationInProgress)", latestLedger: 100, events: [] };
        const call = tx.operations[0].func.invokeContract;
        const contract = Address.fromScAddress(call.contractAddress).toString();
        assert.equal(call.functionName.toString(), "upgrade");
        assert.equal(hex(scValToNative(call.args[0])), wanted);
        const entry = new xdr.SorobanAuthorizationEntry({
          credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
          rootInvocation: authorizedInvocation({ contract, method: "upgrade", args: call.args,
            children: options.nestedAuth ? [{ contract: C(9), method: "transfer", args: [] }] : [],
          }),
        });
        return { _parsed: true, transactionData: new SorobanDataBuilder().setResourceFee(options.resourceFee ?? "0"), minResourceFee: options.resourceFee ?? "0",
          result: { auth: options.extraAuth ? [entry, entry] : [entry], retval: sc.u32(0) }, events: [], latestLedger: 100 };
      },
      sendTransaction: async (tx: any) => {
        sends++; sentTx = tx;
        if (options.rejection !== undefined) throw options.rejection;
        if (options.interrupted) throw new Error("connection lost after possible acceptance");
        return { status: "PENDING", hash: hex(tx.hash()) };
      },
      getTransaction: async () => ({ status: "SUCCESS", txHash: hex(sentTx.hash()), envelopeXdr: sentTx.toEnvelope(), ledger: 101, returnValue: xdr.ScVal.scvVoid() }),
    },
  });
  const run = (role: ContractUpgradeRole, hash = wanted, options: Record<string, unknown> = {}) => role === "registrar"
    ? client.upgradeRegistrar("nova", hash, options) : client.upgradeResolver("nova", hash, options);
  return { client, run, calls, approvalRoles, stats: () => ({ signs, sends, simulated, sentTx }) };
}

for (const role of ["registrar", "resolver"] as const) {
  test(`${role}: verified status and exact owner upgrade do not depend on claim settings`, async () => {
    const f = fixture();
    assert.deepEqual(await f.client.contractUpgradeStatus("nova", role, target), {
      owner, contractId: role === "registrar" ? registrar : resolver, currentHash: hashes[role], approved: true, governed: true,
    });
    const receipt = await f.run(role);
    assert.equal(receipt.ledger, 101);
    assert.equal(f.stats().sends, 1);
    assert(f.approvalRoles.every(value => value === (role === "registrar" ? 0 : 1)));
    assert.equal(Address.fromScAddress(f.stats().sentTx.operations[0].func.invokeContract.contractAddress).toString(), role === "registrar" ? registrar : resolver);
    assert(!f.calls.some(call => /claim_|fee_token|initialization_version/.test(call)));
  });
  for (const options of [{ approved: false }, { governed: false }, { policy: 0 }, { policy: 2 }] as const) {
    test(`${role}: safely reports unavailable permission ${JSON.stringify(options)} and never signs`, async () => {
      const f = fixture(options);
      const status = await f.client.contractUpgradeStatus("nova", role, target);
      assert(!status.approved || !status.governed);
      await assert.rejects(f.run(role), /not approved/);
      assert.equal(f.stats().signs, 0);
    });
  }
  test(`${role}: current owner alone can write; status remains readable`, async () => {
    const f = fixture({ owner: other });
    assert.equal((await f.client.contractUpgradeStatus("nova", role, target)).owner, other);
    await assert.rejects(f.run(role), /current namespace owner/);
    assert.equal(f.stats().signs, 0);
  });
  for (const options of [{ nestedAuth: true }, { extraAuth: true }, { badWallet: "mutate" }, { badWallet: "unsigned" }, { badWallet: "switch" }, { resourceFee: "50000000" }, { migrationActive: true }] as const) {
    test(`${role}: rejected transaction ${JSON.stringify(options)} is never submitted`, async () => {
      const f = fixture(options);
      await assert.rejects(f.run(role));
      assert.equal(f.stats().sends, 0);
      if (!options.badWallet) assert.equal(f.stats().signs, 0);
    });
  }
  test(`${role}: ambiguous submission preserves original hash without retry`, async () => {
    const f = fixture({ interrupted: true });
    await assert.rejects(f.run(role), (error: any) => error.kind === "pending" && error.txHash === hex(f.stats().sentTx.hash()));
    assert.equal(f.stats().sends, 1);
  });
  test(`${role}: a plain-object RPC rejection is described, never rendered as [object Object]`, async () => {
    for (const [rejection, expected] of [[{ code: -32603, message: "rpc down" }, /rpc down/], [{ code: 5 }, /"code":5/]] as const) {
      const f = fixture({ rejection });
      await assert.rejects(f.run(role), (error: any) => error.kind === "pending" && expected.test(error.message) && !error.message.includes("[object Object]") && error.txHash === hex(f.stats().sentTx.hash()));
    }
  });
  test(`${role}: prepared review exposes exact fee/hash and can cancel before signing`, async () => {
    const f = fixture({ resourceFee: "1234" });
    let prepared: any;
    await assert.rejects(f.run(role, target, { onPrepared: (value: any) => {
      prepared = value;
      throw new Error("review cancelled");
    } }), /review cancelled/);
    assert.equal(prepared.feeStroops, 1334n);
    assert.match(prepared.hash, /^[a-f0-9]{64}$/);
    assert.equal(f.stats().signs, 0);
    assert.equal(f.stats().sends, 0);
  });
  test(`${role}: already-installed target and malformed hash fail before signing`, async () => {
    const f = fixture();
    // The approval reader deliberately checks the target selected by the caller.
    const read = (f.client as any).read;
    (f.client as any).read = (id: string, method: string, args: xdr.ScVal[]) => method === "implementation_approved" ? true : read(id, method, args);
    await assert.rejects(f.run(role, hashes[role]), /already installed/);
    for (const hash of ["AB".repeat(32), "aa", "zz".repeat(32)]) await assert.rejects(f.run(role, hash), /hex32/);
    assert.equal(f.stats().signs, 0);
  });
}
for (const options of [{ missingResolver: true }, { wrongSelected: true }, { tainted: true }, { wrongExecutable: "registrar" }, { wrongExecutable: "resolver" }, { wrongAuthority: true }, { wrongProvenance: true }, { wrongAnchors: true }] as const) {
  test(`missing, tainted or mismatched contract cannot be reviewed or upgraded: ${JSON.stringify(options)}`, async () => {
    const f = fixture(options);
    for (const role of ["registrar", "resolver"] as const) {
      await assert.rejects(f.client.contractUpgradeStatus("nova", role, target));
      await assert.rejects(f.run(role));
    }
    assert.equal(f.stats().signs, 0);
  });
}

const { registrar: reg, resolver: res } = CONTRACT_RELEASES;
const RELEASES = { registrar: reg, resolver: res } as const;

test("contractUpgradeDirection separates forward, same, backward and unprovable transitions (D68-01)", () => {
  for (const role of ["registrar", "resolver"] as const) {
    const { latest, superseded } = RELEASES[role];
    const unknown = "cd".repeat(32);
    for (const old of superseded) {
      assert.equal(contractUpgradeDirection(role, old, latest), "forward", `${role} ${old} -> latest`);
      assert.equal(contractUpgradeDirection(role, latest, old), "backward", `${role} latest -> ${old}`);
      assert.equal(contractUpgradeDirection(role, old, old), "same");
      for (const other of superseded) if (other !== old) assert.equal(contractUpgradeDirection(role, old, other), "backward", "superseded targets are never installation targets");
      assert.equal(contractUpgradeDirection(role, unknown, old), "backward", "an older target is a downgrade whatever runs now");
    }
    assert.equal(contractUpgradeDirection(role, latest, latest), "same");
    assert.equal(contractUpgradeDirection(role, unknown, latest), "unrecognized-current", "the latest known release over code this SDK cannot place may be a downgrade");
    assert.equal(contractUpgradeDirection(role, latest, unknown), "unreviewed-target");
    assert.equal(contractUpgradeDirection(role, unknown, unknown), "same");
    assert.equal(contractUpgradeDirection(role, unknown, "ef".repeat(32)), "unreviewed-target");
  }
});

for (const role of ["registrar", "resolver"] as const) {
  const { latest, superseded } = RELEASES[role];
  test(`${role}: an upgrade from a superseded release to the latest still installs`, async () => {
    const f = fixture({ target: latest, current: { [role]: superseded[0] } });
    assert.equal((await f.run(role)).ledger, 101);
    assert.equal(f.stats().sends, 1);
  });
  for (const old of superseded) test(`${role}: downgrade to superseded ${old.slice(0, 8)} is refused before signing unless explicitly acknowledged`, async () => {
    const refused = fixture({ target: old, current: { [role]: latest } });
    await assert.rejects(refused.run(role), /superseded implementation.*downgrade/i);
    for (const allowDowngrade of [false, undefined, "true", 1]) await assert.rejects(refused.run(role, old, { allowDowngrade }), /superseded/);
    assert.deepEqual([refused.stats().signs, refused.stats().sends, refused.stats().simulated], [0, 0, 0], "nothing is prepared, signed or sent");
    const acknowledged = fixture({ target: old, current: { [role]: latest } });
    assert.equal((await acknowledged.run(role, old, { allowDowngrade: true })).ledger, 101);
    assert.equal(acknowledged.stats().sends, 1);
  });
  test(`${role}: reinstalling the installed release is refused even with the downgrade acknowledgement`, async () => {
    const f = fixture({ target: latest, current: { [role]: latest } });
    await assert.rejects(f.run(role), /already installed/);
    await assert.rejects(f.run(role, latest, { allowDowngrade: true }), /already installed/);
    assert.equal(f.stats().signs, 0);
  });
  test(`${role}: the latest known release over unrecognised installed code needs an acknowledgement`, async () => {
    const f = fixture({ target: latest, current: { [role]: "77".repeat(32) } });
    await assert.rejects(f.run(role), /does not recognise/);
    assert.equal(f.stats().signs, 0);
    const acknowledged = fixture({ target: latest, current: { [role]: "77".repeat(32) } });
    assert.equal((await acknowledged.run(role, latest, { allowDowngrade: true })).ledger, 101);
  });
}

test("the SDK release lineage equals exported public catalog and reviewed October 1 metadata", () => {
  const record = JSON.parse(readFileSync(new URL("../../../fixtures/release-catalog.json", import.meta.url), "utf8"));
  assert.equal(record.sourceRevision, "cec2d29bd392c64ac3e7f8d1d20d626736c72ce5");
  for (const role of ["registrar", "resolver"] as const) {
    assert.equal(RELEASES[role].latest, record.catalog[role].latest);
    assert.deepEqual([...RELEASES[role].superseded].sort(), [...record.catalog[role].superseded].sort());
    assert.equal(RELEASES[role].latest, record.artifacts[role].sha256);
    assert.ok(!(RELEASES[role].superseded as readonly string[]).includes(RELEASES[role].latest));
  }
});
