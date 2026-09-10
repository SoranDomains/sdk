import assert from 'node:assert/strict';
import { Address, Contract, Networks, SorobanDataBuilder, StrKey, Transaction, hash, scValToNative, xdr } from '@stellar/stellar-sdk';
import { SoranHolder as Client, claimIntentToScVal, nativeIntentHash, type ClaimIntent } from '@sorandomains/holder';
import { hex, namespaceNode, sc, struct, unhex, utf8 } from '../../node_modules/@sorandomains/holder/dist/native-codec.js';
import { instanceProof } from './native-ledger';

const C = (n: number) => StrKey.encodeContract(new Uint8Array(32).fill(n));
const G = StrKey.encodeEd25519PublicKey(new Uint8Array(32).fill(8));
const registry = C(1), registrar = C(2), resolver = C(3), token = C(4), target = C(5), lookup = C(6);
const sourceHash = '26e03cd1d7fbfa46fe442406fb1b88022ec8cd8bd9123bed570f971fce596a14';
const namespace = hex(namespaceNode('nova')), network = hex(hash(utf8(Networks.TESTNET)));
const original: ClaimIntent = { context: { network, registry, registrar, namespace, requestId: 'ab'.repeat(32), validAfter: 1000n, deadline: 1100n }, label: 'alice', claimant: G, destination: { address: G, memo: { type: 'id', value: '42' } }, resolver, expectedGeneration: null, expectedExpiry: null, termSecs: 100n, ownerEpoch: 1n, policyVersion: 2n, grantEpoch: 3n, feeToken: token, feeAmount: 5000n, feeRecipient: G };
function native(value: unknown): xdr.ScVal {
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
function rootOf(leaf: Record<string, unknown>, source = registry, successor = target, net = network): Uint8Array {
  const pieces = [utf8('soran:registry-migration:v1\0'), unhex(net), sc.address(source).toXdr(), sc.address(successor).toXdr(), native(leaf).toXdr()];
  const bytes = new Uint8Array(pieces.reduce((sum, piece) => sum + piece.length, 0));
  let i = 0; for (const piece of pieces) { bytes.set(piece, i); i += piece.length; }
  return new Uint8Array(hash(bytes));
}
function receipt() {
  const node = new Uint8Array(64); node.set(unhex(namespace)); node.set(hash(utf8('alice')), 32);
  return { operation: ['Claim'], intent_hash: unhex(nativeIntentHash('claim', claimIntentToScVal(original))), node: new Uint8Array(hash(node)), holder: G, generation: 0n, expires_at: 1100n, fee_amount: 5000n, fee_token: token, fee_recipient: G, ledger: 100, timestamp: 1000n };
}
function fixture() {
  const leaf = { label: utf8('nova'), owner: G, owner_epoch: 1n, source_registrar: registrar, source_registrar_hash: unhex(sourceHash), source_resolver: resolver, source_resolver_hash: new Uint8Array(32).fill(3), treasury: G, policy: { reclaimable: false, transferable: true, tradeable: false, default_term_secs: 100n, trade_fee_bps: 0 }, pending_transfer: [], registrar_root: new Uint8Array(32).fill(10), registrar_count: 3, resolver_root: new Uint8Array(32).fill(11), resolver_count: 2 };
  const plan = { source_registry: registry, source_registry_hash: new Uint8Array(32).fill(1), namespace_root: rootOf(leaf), namespace_count: 1, ownership_sequence: 1n, primary_source: C(7), primary_source_hash: new Uint8Array(32).fill(7), primary_target: C(9), primary_target_hash: new Uint8Array(32).fill(9), primary_root: new Uint8Array(32).fill(12), primary_count: 1 };
  const status = { plan, imported: [unhex(namespace)], completed: [unhex(namespace)], sealed: true, primary_initialized: true };
  const values = { registry: target, registry_migration_version: 1, migration_version: 1, migration_active: false, migration_status: status, migration_namespace: leaf, migration_export_frozen: true, migration_export_version: 1, migration_export_target: target, anchors: [registry, unhex(namespace)], registrar_of: registrar, claim_receipt: receipt() as ReturnType<typeof receipt> | null };
  let signs = 0, sends = 0, receiptSeen = false;
  const client = new Client({ registryId: target, passphrase: Networks.TESTNET, signer: { publicKey: () => { throw new Error('historical reads must not request a signer'); }, signTransaction: async () => { signs++; throw new Error('must not sign'); } } });
  const calls: string[] = [], ledgers: Record<string, unknown> = {};
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
      const selected = values[method as keyof typeof values];
      let retval = native(selected);
      if (method === 'claim_receipt' && values.claim_receipt !== null) retval = struct({ ...Object.fromEntries(Object.entries(values.claim_receipt).map(([k, v]) => [k, native(v)])), fee_amount: sc.i128(values.claim_receipt.fee_amount) });
      return { _parsed: true, transactionData: new SorobanDataBuilder(), minResourceFee: '0', events: [], latestLedger: Object.hasOwn(ledgers, method) ? ledgers[method] : method === 'claim_receipt' ? 200 : receiptSeen ? 201 : 190, result: { auth: [], retval } };
    },
    getLedgerEntries: async (key: xdr.LedgerKey) => {
      calls.push('getLedgerEntries');
      const id = [registry, registrar].find(id => new Contract(id).getFootprint().toXdr('base64') === key.toXdr('base64')); assert(id);
      const proof = instanceProof(id, (Object.hasOwn(ledgers, 'executable') ? ledgers.executable : 202) as number, hashes[id]); hooks.proof?.(proof); return proof;
    },
    sendTransaction: async () => { sends++; throw new Error('must not submit'); },
  };
  Object.assign(client, { server });
  const run = (input = original) => client.recoverHistoricalClaim(input, { lookupId: lookup });
  return { client, run, leaf, plan, status, values, calls, ledgers, hashes, hooks, counts: () => ({ signs, sends }) };
}


export { fixture, original, registry, registrar, target, lookup, sourceHash };
