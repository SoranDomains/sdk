import assert from 'node:assert/strict';
import test from 'node:test';
import { Address, Contract, Networks, SorobanDataBuilder, StrKey, Transaction, hash, scValToNative, xdr } from '@stellar/stellar-sdk';
import { SoranHolder as Client, claimIntentToScVal, nativeIntentHash, type ClaimIntent } from '../src/index.js';
import { hex, namespaceNode, sc, struct, unhex, utf8 } from '../src/native-codec.js';
import { instanceProof } from './helpers/native-ledger.mjs';

const C = (n: number) => StrKey.encodeContract(new Uint8Array(32).fill(n));
const G = StrKey.encodeEd25519PublicKey(new Uint8Array(32).fill(8));
const registry = C(1), registrar = C(2), resolver = C(3), token = C(4), target = C(5), lookup = C(6);
const sourceHash = '26e03cd1d7fbfa46fe442406fb1b88022ec8cd8bd9123bed570f971fce596a14';
const namespace = hex(namespaceNode('nova')), network = hex(hash(utf8(Networks.TESTNET)));
const original: ClaimIntent = { context: { network, registry, registrar, namespace, requestId: 'ab'.repeat(32), validAfter: 1000n, deadline: 1100n }, label: 'alice', claimant: G, destination: { address: G, memo: { type: 'id', value: '42' } }, resolver, expectedGeneration: null, expectedExpiry: null, termSecs: 100n, ownerEpoch: 1n, policyVersion: 2n, grantEpoch: 3n, feeToken: token, feeAmount: 5000n, feeRecipient: G };
function native(value: any): xdr.ScVal {
  if (value === null) return xdr.ScVal.scvVoid();
  if (value instanceof Uint8Array) return sc.bytes(value);
  if (Array.isArray(value)) return xdr.ScVal.scvVec(value.map(native));
  if (typeof value === 'object') return struct(Object.fromEntries(Object.entries(value).map(([key, item]) => [key, native(item)])));
  if (typeof value === 'string') return StrKey.isValidContract(value) || StrKey.isValidEd25519PublicKey(value) ? sc.address(value) : sc.symbol(value);
  if (typeof value === 'bigint') return sc.u64(value);
  if (typeof value === 'number') return sc.u32(value);
  if (typeof value === 'boolean') return sc.bool(value);
  throw new Error('unsupported test value');
}
function rootOf(leaf: Record<string, any>, source = registry, successor = target, net = network): Uint8Array {
  const pieces = [utf8('soran:registry-migration:v1\0'), unhex(net), sc.address(source).toXDR(), sc.address(successor).toXDR(), native(leaf).toXDR()];
  const bytes = new Uint8Array(pieces.reduce((sum, piece) => sum + piece.length, 0));
  let i = 0; for (const piece of pieces) { bytes.set(piece, i); i += piece.length; }
  return new Uint8Array(hash(bytes));
}
function receipt() {
  const node = new Uint8Array(64); node.set(unhex(namespace)); node.set(hash(utf8('alice')), 32);
  return { operation: ['Claim'], intent_hash: unhex(nativeIntentHash('claim', claimIntentToScVal(original))), node: new Uint8Array(hash(node)), holder: G, generation: 0n, expires_at: 1100n, fee_amount: 5000n, fee_token: token, fee_recipient: G, ledger: 100, timestamp: 1000n };
}
type Fixture = ReturnType<typeof fixture>;
function fixture() {
  const leaf: Record<string, any> = { label: utf8('nova'), owner: G, owner_epoch: 1n, source_registrar: registrar, source_registrar_hash: unhex(sourceHash), source_resolver: resolver, source_resolver_hash: new Uint8Array(32).fill(3), treasury: G, policy: { reclaimable: false, transferable: true, tradeable: false, default_term_secs: 100n, trade_fee_bps: 0 }, pending_transfer: [], registrar_root: new Uint8Array(32).fill(10), registrar_count: 3, resolver_root: new Uint8Array(32).fill(11), resolver_count: 2 };
  const plan = { source_registry: registry, source_registry_hash: new Uint8Array(32).fill(1), namespace_root: rootOf(leaf), namespace_count: 1, ownership_sequence: 1n, primary_source: C(7), primary_source_hash: new Uint8Array(32).fill(7), primary_target: C(9), primary_target_hash: new Uint8Array(32).fill(9), primary_root: new Uint8Array(32).fill(12), primary_count: 1 };
  const status = { plan, imported: [unhex(namespace)], completed: [unhex(namespace)], sealed: true, primary_initialized: true };
  const values: Record<string, any> = { registry: target, registry_migration_version: 1, migration_version: 1, migration_active: false, migration_status: status, migration_namespace: leaf, migration_export_frozen: true, migration_export_version: 1, migration_export_target: target, anchors: [registry, unhex(namespace)], registrar_of: registrar, claim_receipt: receipt() };
  let signs = 0, sends = 0, receiptSeen = false;
  const client = new Client({ registryId: target, passphrase: Networks.TESTNET, signer: { publicKey: () => { throw new Error('historical reads must not request a signer'); }, signTransaction: async () => { signs++; throw new Error('must not sign'); } } });
  const calls: string[] = [], ledgers: Record<string, any> = {};
  const hashes: Record<string, Uint8Array> = { [registrar]: unhex(sourceHash), [registry]: new Uint8Array(32).fill(1) };
  const hooks: { before?: (method: string) => void; proof?: (proof: ReturnType<typeof instanceProof>) => void } = {};
  const server = {
    simulateTransaction: async (tx: Transaction) => {
      const op = tx.operations[0];
      if (op.type !== 'invokeHostFunction' || op.func.type !== 'hostFunctionTypeInvokeContract') throw new Error('not a read');
      const inv = op.func.invokeContract, method = inv.functionName.toString(), contract = Address.fromScAddress(inv.contractAddress).toString();
      calls.push(method); hooks.before?.(method);
      const expected = ['registry', 'registry_migration_version'].includes(method) ? lookup : ['migration_version', 'migration_active', 'migration_status', 'migration_namespace'].includes(method) ? target : method === 'registrar_of' ? registry : registrar;
      assert.equal(contract, expected, 'reads must retain the original source and trusted successor addresses');
      if (method === 'claim_receipt') { assert.equal(scValToNative(inv.args[0]), G); assert.equal(hex(scValToNative(inv.args[1])), original.context.requestId); }
      if (method === 'migration_namespace' || method === 'registrar_of') assert.equal(hex(scValToNative(inv.args[0])), namespace);
      if (method === 'claim_receipt') receiptSeen = true;
      let retval = native(values[method]);
      if (method === 'claim_receipt' && values[method] !== null) retval = struct({ ...Object.fromEntries(Object.entries(values[method]).map(([k, v]) => [k, native(v)])), fee_amount: sc.i128(values[method].fee_amount) });
      return { _parsed: true, transactionData: new SorobanDataBuilder(), minResourceFee: '0', events: [], latestLedger: Object.hasOwn(ledgers, method) ? ledgers[method] : method === 'claim_receipt' ? 200 : receiptSeen ? 201 : 190, result: { auth: [], retval } };
    },
    getLedgerEntries: async (key: xdr.LedgerKey) => {
      calls.push('getLedgerEntries');
      const id = [registry, registrar].find(id => new Contract(id).getFootprint().toXDR('base64') === key.toXDR('base64')); assert(id);
      const proof = instanceProof(id, Object.hasOwn(ledgers, 'executable') ? ledgers.executable : 202, hashes[id]); hooks.proof?.(proof); return proof;
    },
    sendTransaction: async () => { sends++; throw new Error('must not submit'); },
  };
  Object.assign(client, { server });
  const run = (input = original) => client.recoverHistoricalClaim(input, { lookupId: lookup });
  return { client, run, leaf, plan, status, values, calls, ledgers, hashes, hooks, counts: () => ({ signs, sends }) };
}

test('post-cutover recovery reads the original receipt through sealed migration lineage without a wallet', async () => {
  const f = fixture(), result = await f.run(); assert(result);
  assert.equal(result.intentHash, nativeIntentHash('claim', claimIntentToScVal(original)));
  assert.equal(result.feeAmount, 5000n); assert.equal(result.ledger, 100);
  assert.deepEqual(f.calls.slice(0, 4), ['registry', 'migration_status', 'migration_export_frozen', 'claim_receipt']); assert.deepEqual(f.counts(), { signs: 0, sends: 0 });
});
test('verified historical absence returns null without authorizing submission', async () => {
  const f = fixture(); f.values.claim_receipt = null;
  assert.equal(await f.run(), null); assert(f.calls.includes('migration_status')); assert.deepEqual(f.counts(), { signs: 0, sends: 0 });
});
const attacks: Record<string, (f: Fixture) => void> = {
  'Lookup still on source': f => { f.values.registry = registry; },
  'unsupported Lookup': f => { f.values.registry_migration_version = 2; },
  'unsupported Registry': f => { f.values.migration_version = 2; },
  'active import': f => { f.values.migration_active = true; },
  'unsealed state': f => { f.status.sealed = false; },
  'unfinished Primary': f => { f.status.primary_initialized = false; },
  'missing namespace import': f => { f.status.imported = []; },
  'missing namespace completion': f => { f.status.completed = []; },
  'different source Registry': f => { f.plan.source_registry = C(20); },
  'different source Registrar': f => { f.leaf.source_registrar = C(20); },
  'different source Resolver': f => { f.leaf.source_resolver = C(20); },
  'different namespace': f => { f.leaf.label = utf8('other'); },
  'unreviewed source code even if committed': f => { f.hashes[registrar] = new Uint8Array(32).fill(20); f.leaf.source_registrar_hash = f.hashes[registrar]; f.plan.namespace_root = rootOf(f.leaf); },
  'changed source executable': f => { f.hashes[registrar] = new Uint8Array(32).fill(20); },
  'changed source Registry code': f => { f.hashes[registry] = new Uint8Array(32).fill(20); },
  'different committed source code': f => { f.leaf.source_registrar_hash = new Uint8Array(32).fill(20); },
  'wrong Merkle root': f => { f.plan.namespace_root = new Uint8Array(32).fill(20); },
  'root replay from another target': f => { f.plan.namespace_root = rootOf(f.leaf, registry, C(20)); },
  'root replay from another network': f => { f.plan.namespace_root = rootOf(f.leaf, registry, target, '20'.repeat(32)); },
  'source not frozen': f => { f.values.migration_export_frozen = false; },
  'different freeze target': f => { f.values.migration_export_target = C(20); },
  'invalid export version': f => { f.values.migration_export_version = 2; },
  'source attestation changed': f => { f.values.registrar_of = C(20); },
  'source Registry anchor changed': f => { f.values.anchors[0] = C(20); },
  'source namespace anchor changed': f => { f.values.anchors[1] = new Uint8Array(32).fill(20); },
  'pending namespace transfer': f => { f.leaf.pending_transfer = [{ to: G, expires: 1n }]; f.plan.namespace_root = rootOf(f.leaf); },
  'incomplete count': f => { f.plan.namespace_count = 2; },
  'forged receipt intent hash': f => { f.values.claim_receipt.intent_hash = new Uint8Array(32); },
  'forged receipt name': f => { f.values.claim_receipt.node = new Uint8Array(32); },
  'forged holder': f => { f.values.claim_receipt.holder = StrKey.encodeEd25519PublicKey(new Uint8Array(32)); },
  'forged operation': f => { f.values.claim_receipt.operation = ['Renew']; },
  'forged generation': f => { f.values.claim_receipt.generation = 1n; },
  'forged expiry': f => { f.values.claim_receipt.expires_at = 1101n; },
  'forged fee amount': f => { f.values.claim_receipt.fee_amount = 5001n; },
  'forged fee token': f => { f.values.claim_receipt.fee_token = C(20); },
  'forged fee recipient': f => { f.values.claim_receipt.fee_recipient = null; },
  'receipt before request window': f => { f.values.claim_receipt.timestamp = 999n; },
  'receipt after deadline': f => { f.values.claim_receipt.timestamp = 1101n; },
  'receipt after observed ledger': f => { f.values.claim_receipt.ledger = 201; },
};
for (const [name, tamper] of Object.entries(attacks)) test(`historical recovery rejects ${name}`, async () => {
  const f = fixture(); tamper(f); await assert.rejects(f.run()); assert.deepEqual(f.counts(), { signs: 0, sends: 0 });
});
for (const method of ['claim_receipt', 'registry', 'registry_migration_version', 'migration_version', 'migration_active', 'migration_status', 'migration_namespace', 'migration_export_frozen', 'migration_export_version', 'migration_export_target', 'anchors', 'registrar_of', 'executable']) test(`historical ${method} requires valid fresh ledger context`, async () => {
  const f = fixture(); f.ledgers[method] = method === 'claim_receipt' ? undefined : 199;
  await assert.rejects(f.run(), /ledger context/); assert.deepEqual(f.counts(), { signs: 0, sends: 0 });
});
for (const kind of ['missing', 'wrong-key', 'wrong-contract', 'temporary', 'non-wasm'] as const) test(`historical executable rejects ${kind}`, async () => {
  const f = fixture(); f.hooks.proof = proof => {
    if (kind === 'missing') { proof.entries.length = 0; return; }
    const entry = proof.entries[0];
    if (kind === 'wrong-key') { entry.key = new Contract(token).getFootprint(); return; }
    assert.equal(entry.val.type, 'contractData'); if (entry.val.type !== 'contractData') throw new Error('fixture');
    const d = entry.val.value, fields = { ext: d.ext, contract: d.contract, key: d.key, durability: d.durability, val: d.val };
    if (kind === 'wrong-contract') fields.contract = new Contract(token).address().toScAddress();
    if (kind === 'temporary') fields.durability = xdr.ContractDataDurability.temporary;
    if (kind === 'non-wasm') fields.val = xdr.ScVal.scvContractInstance(new xdr.ScContractInstance({ executable: xdr.ContractExecutable.contractExecutableStellarAsset(), storage: null }));
    entry.val = xdr.LedgerEntryData.contractData(new xdr.ContractDataEntry(fields));
  };
  await assert.rejects(f.run(), /executable proof/);
});
test('historical null is rejected when its provenance is unverified', async () => {
  const f = fixture(); f.values.claim_receipt = null; f.status.sealed = false; await assert.rejects(f.run(), /not fully sealed/);
});
test('request fields stay bound to the complete saved intent', async () => {
  for (const patch of [{ destination: { address: G, memo: { type: 'id', value: '43' } } }, { feeAmount: 5001n }, { policyVersion: 9n }, { grantEpoch: 9n }, { ownerEpoch: 9n }]) {
    const f = fixture(); await assert.rejects(f.run({ ...original, ...patch } as ClaimIntent));
  }
});
test('snapshot the saved intent and Lookup before awaiting RPC', async () => {
  const f = fixture(), input = structuredClone(original), options = { lookupId: lookup };
  f.hooks.before = () => { input.context.requestId = 'cd'.repeat(32); input.destination = { address: G, memo: { type: 'none' } }; options.lookupId = C(20); };
  assert(await f.client.recoverHistoricalClaim(input, options));
});
test('original network and source Registry cannot be rewritten to current defaults', async () => {
  const f = fixture();
  await assert.rejects(f.run({ ...original, context: { ...original.context, registry: target } }), /saved original network/);
  await assert.rejects(f.run({ ...original, context: { ...original.context, network: '20'.repeat(32) } }), /saved original network/);
  assert.equal(f.calls.length, 0);
});


test('SDK namespace commitment matches the native Registry golden vector', () => {
  assert.equal(hex(fixture().plan.namespace_root), '3467b93201e13753d243eb3a20916482b803739734cb03c252d7ac793f0d0ab5');
});
for (const [name, destination] of Object.entries({
  'G without memo': { address: G, memo: { type: 'none' } },
  'muxed M route': { address: StrKey.encodeMed25519PublicKey(new Uint8Array(40).fill(8)), memo: { type: 'none' } },
  'C contract route': { address: token, memo: { type: 'none' } },
})) test(`historical recovery preserves ${name} and zero-fee receipts`, async () => {
  const f = fixture(), input = { ...original, destination, feeAmount: 0n } as ClaimIntent;
  f.values.claim_receipt.intent_hash = unhex(nativeIntentHash('claim', claimIntentToScVal(input)));
  f.values.claim_receipt.fee_amount = 0n; f.values.claim_receipt.fee_recipient = null;
  assert(await f.run(input)); assert.deepEqual(f.counts(), { signs: 0, sends: 0 });
});
test('historical recovery preserves a reissued permanent generation', async () => {
  const f = fixture(), input = { ...original, expectedGeneration: 4n, expectedExpiry: 999n, termSecs: 0n };
  f.values.claim_receipt.intent_hash = unhex(nativeIntentHash('claim', claimIntentToScVal(input)));
  f.values.claim_receipt.generation = 5n; f.values.claim_receipt.expires_at = 0n;
  assert(await f.run(input));
});


test('a receipt read before the established freeze ledger cannot establish historical absence', async () => {
  const f = fixture(); f.values.claim_receipt = null;
  f.ledgers.migration_export_frozen = 201; f.ledgers.claim_receipt = 200;
  await assert.rejects(f.run(), /ledger context/); assert.deepEqual(f.counts(), { signs: 0, sends: 0 });
});
test('a claim appearing before freeze is read from frozen state rather than an earlier null', async () => {
  const f = fixture(); f.values.claim_receipt = null;
  f.hooks.before = method => { if (method === 'migration_export_frozen') f.values.claim_receipt = receipt(); };
  const result = await f.run(); assert.equal(result?.ledger, 100);
  assert(f.calls.indexOf('migration_export_frozen') < f.calls.indexOf('claim_receipt'));
});


test('same-Registrar history survives a later Resolver replacement without rewriting the original intent', async () => {
  const f = fixture(); f.leaf.source_resolver = C(20); f.plan.namespace_root = rootOf(f.leaf);
  assert(await f.run());
  const next = fixture(); next.leaf.source_resolver = C(20); next.plan.namespace_root = rootOf(next.leaf);
  await assert.rejects(next.run({ ...original, resolver: C(20) }), /complete original immutable claim intent/);
});
