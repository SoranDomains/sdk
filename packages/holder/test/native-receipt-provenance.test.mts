import assert from 'node:assert/strict';
import test from 'node:test';
import { Account, Address, Contract, Keypair, Networks, SorobanDataBuilder, StrKey, Transaction, hash, scValToNative, xdr } from '@stellar/stellar-sdk';
import { SoranHolder, claimIntentToScVal, nativeIntentHash, renewIntentToScVal, transferIntentToScVal, type ClaimIntent, type RenewIntent, type TransferIntent } from '../src/index.js';
import { hex, namespaceNode, sc, struct, unhex } from '../src/native-codec.js';
import { instanceProof } from './helpers/native-ledger.mjs';

const G = Keypair.random().publicKey(), previous = Keypair.random().publicKey();
const C = (n: number) => StrKey.encodeContract(new Uint8Array(32).fill(n));
const registry = C(1), registrar = C(2), resolver = C(3), token = C(4);
const namespace = hex(namespaceNode('nova'));
const context = { network: hex(hash(new TextEncoder().encode(Networks.TESTNET))), registry, registrar, namespace, requestId: 'ab'.repeat(32), validAfter: 1000n, deadline: 1100n };
const claim: ClaimIntent = { context, label: 'alice', claimant: G, destination: { address: G, memo: { type: 'none' } }, resolver, expectedGeneration: null, expectedExpiry: null, termSecs: 100n, ownerEpoch: 1n, policyVersion: 2n, grantEpoch: 3n, feeToken: token, feeAmount: 0n, feeRecipient: previous };
const transfer: TransferIntent = { context, label: 'alice', from: previous, to: G, expectedGeneration: 7n, expectedExpiry: 2000n, proposalExpires: 1050n, destination: claim.destination, resolver };
const renew: RenewIntent = { context, label: 'alice', holder: G, expectedGeneration: 7n, expectedExpiry: 999n, termSecs: 100n, minNewExpiry: 1100n, maxNewExpiry: 1200n };
type Method = 'claim' | 'accept_transfer_with_destination' | 'renew_holder';
function receipt(method: Method = 'claim', changes: Record<string, xdr.ScVal> = {}) {
  const encoded = method === 'claim' ? claimIntentToScVal(claim) : method === 'renew_holder' ? renewIntentToScVal(renew) : transferIntentToScVal(transfer);
  const parts = new Uint8Array(64); parts.set(unhex(namespace)); parts.set(hash(new TextEncoder().encode('alice')), 32);
  return struct({
    operation: xdr.ScVal.scvVec([sc.symbol(method === 'claim' ? 'Claim' : method === 'renew_holder' ? 'Renew' : 'Transfer')]),
    intent_hash: sc.bytes(unhex(nativeIntentHash(method, encoded))), node: sc.bytes(hash(parts)), holder: sc.address(G),
    generation: sc.u64(method === 'claim' ? 0n : method === 'renew_holder' ? 7n : 8n), expires_at: sc.u64(method === 'accept_transfer_with_destination' ? 2000n : 1100n),
    fee_amount: sc.i128(0n), fee_token: sc.address(token), fee_recipient: xdr.ScVal.scvVoid(), ledger: sc.u32(100), timestamp: sc.u64(1000n), ...changes,
  });
}
type Options = {
  method?: Method; record?: xdr.ScVal; receiptLedger?: unknown; postLedger?: unknown; entryLedger?: unknown;
  onSimulate?: (method: string) => void; staleMethod?: string; taintedAfter?: boolean; hashAfter?: Uint8Array; entryMutation?: (proof: ReturnType<typeof instanceProof>) => void;
};
/** Public adapter exercised unmodified: only the server boundary is substituted. */
function fixture(options: Options = {}) {
  let receiptSeen = false, signed = 0, submitted = 0;
  const calls: string[] = [];
  const record = options.record ?? receipt(options.method);
  const own = (key: keyof Options, fallback: unknown) => Object.hasOwn(options, key) ? options[key] : fallback;
  const holder = new SoranHolder({ registryId: registry, passphrase: Networks.TESTNET, signer: {
    publicKey: () => G, signTransaction: async () => { signed++; throw new Error('recovery must never sign'); },
  } });
  const server = {
    getAccount: async () => new Account(G, '0'),
    getContractInstance: async () => {
      const data = instanceProof(registrar).entries[0].val;
      assert.equal(data.type, 'contractData');
      if (data.type !== 'contractData' || data.value.val.type !== 'scvContractInstance') throw new Error('fixture');
      return data.value.val.value;
    },
    getLedgerEntries: async (key: xdr.LedgerKey) => {
      if (key.toXDR('base64') === new Contract(registry).getFootprint().toXDR('base64')) return instanceProof(registry, receiptSeen ? own('receiptLedger', 200) as number : 190);
      calls.push('getLedgerEntries');
      assert(receiptSeen, 'receipt proof must follow the actual simulation');
      assert.equal(key.toXDR('base64'), new Contract(registrar).getFootprint().toXDR('base64'));
      const proof = instanceProof(registrar, own('entryLedger', 201) as number, options.hashAfter);
      options.entryMutation?.(proof);
      return proof;
    },
    simulateTransaction: async (tx: Transaction) => {
      const op = tx.operations[0]; assert.equal(op.type, 'invokeHostFunction');
      if (op.type !== 'invokeHostFunction' || op.func.type !== 'hostFunctionTypeInvokeContract') throw new Error('unexpected operation');
      const invocation = op.func.invokeContract, method = invocation.functionName.toString();
      const contract = Address.fromScAddress(invocation.contractAddress).toString();
      calls.push(method); options.onSimulate?.(method);
      let value: xdr.ScVal;
      if (method === 'claim_receipt') {
        assert.equal(contract, registrar); assert.equal(scValToNative(invocation.args[0]), G); assert.equal(hex(scValToNative(invocation.args[1])), context.requestId);
        value = record; receiptSeen = true;
      } else if (method === 'registrar_of') { assert.equal(contract, registry); value = sc.address(registrar); }
      else if (method === 'registrar_tainted') value = xdr.ScVal.scvBool(receiptSeen && !!options.taintedAfter);
      else if (method === 'template_hashes') value = xdr.ScVal.scvVec([sc.bytes(new Uint8Array(32)), sc.bytes(new Uint8Array(32))]);
      else if (method === 'anchors') value = xdr.ScVal.scvVec([sc.address(registry), sc.bytes(unhex(namespace))]);
      else if (method === 'claim_version') value = sc.u32(1);
      else throw new Error(`historical receipts must not depend on current ${method}`);
      const ledger = method === 'claim_receipt' ? own('receiptLedger', 200) : receiptSeen ? (options.staleMethod === method ? 199 : own('postLedger', 201)) : 190;
      return { _parsed: true, transactionData: new SorobanDataBuilder(), minResourceFee: '0', events: [], latestLedger: ledger, result: { auth: [], retval: value } };
    },
    sendTransaction: async () => { submitted++; throw new Error('recovery must never submit'); },
  };
  Object.assign(holder, { server });
  return { holder, calls, counts: () => ({ signed, submitted }) };
}
const publicCalls = {
  direct: (holder: SoranHolder) => holder.claimReceipt('nova', G, context.requestId),
  recovery: (holder: SoranHolder) => holder.recoverClaim(claim),
  claim: (holder: SoranHolder) => holder.claim(claim),
  transfer: (holder: SoranHolder) => holder.acceptNameTransferWithDestination(transfer),
  renew: (holder: SoranHolder) => holder.renewName(renew),
};
for (const [name, run] of Object.entries(publicCalls)) {
  const method: Method = name === 'transfer' ? 'accept_transfer_with_destination' : name === 'renew' ? 'renew_holder' : 'claim';
  test(`public ${name} accepts historical receipt with clean newer SDK17 ledger evidence`, async () => {
    const f = fixture({ method }); const value = await run(f.holder); assert(value);
    assert(f.calls.indexOf('claim_receipt') < f.calls.indexOf('getLedgerEntries'));
    assert.deepEqual(f.counts(), { signed: 0, submitted: 0 });
  });
  test(`public ${name} rejects owner upgrade between clean precheck and receipt read`, async () => {
    const f = fixture({ method, taintedAfter: true });
    await assert.rejects(run(f.holder), /provenance changed/); assert.deepEqual(f.counts(), { signed: 0, submitted: 0 });
  });
}
for (const bad of [undefined, null, '200', 0, -1, 200.5, NaN, Infinity, 0x1_0000_0000]) test(`public adapter rejects receipt simulation ledger ${String(bad)}`, async () => {
  const f = fixture({ receiptLedger: bad }); await assert.rejects(f.holder.recoverClaim(claim), /ledger context/); assert.deepEqual(f.counts(), { signed: 0, submitted: 0 });
});
for (const method of ['registrar_of', 'registrar_tainted', 'template_hashes']) test(`post-receipt ${method} cannot use an older RPC snapshot`, async () => {
  const f = fixture({ staleMethod: method }); await assert.rejects(f.holder.recoverClaim(claim), /ledger context/);
});
for (const bad of [undefined, '201', 0, 199]) test(`SDK17 executable proof requires fresh valid ledger ${String(bad)}`, async () => {
  const f = fixture({ entryLedger: bad }); await assert.rejects(f.holder.recoverClaim(claim), /ledger context/);
});
test('same ledger clean proof is sufficient; separate proof ledgers need not be identical', async () => {
  const f = fixture({ postLedger: 200, entryLedger: 205 }); assert(await f.holder.recoverClaim(claim));
});
test('historical claim after later owner/policy/Resolver changes reads no current owner/config/Resolver', async () => {
  const f = fixture({ receiptLedger: 10_000, postLedger: 10_001, entryLedger: 10_002 });
  const recovered = await f.holder.recoverClaim(claim); assert.equal(recovered?.ledger, 100); assert.equal(recovered?.timestamp, 1000n);
  assert(!f.calls.some(name => /owner|config|quote|native_contracts|resolver/.test(name)));
});
for (const method of ['recoverClaim', 'claim', 'buildClaim'] as const) test(`unverified receipt absence cannot drive ${method}`, async () => {
  const f = fixture({ record: xdr.ScVal.scvVoid(), taintedAfter: true });
  await assert.rejects(f.holder[method](claim), /provenance changed/); assert.deepEqual(f.counts(), { signed: 0, submitted: 0 });
});
test('clean confirmed absence remains null without a signer', async () => {
  const f = fixture({ record: xdr.ScVal.scvVoid() }); assert.equal(await f.holder.recoverClaim(claim), null);
});
for (const [name, changes] of Object.entries<Record<string, xdr.ScVal>>({
  'zero inclusion ledger': { ledger: sc.u32(0) }, 'future inclusion ledger': { ledger: sc.u32(201) },
  'another holder': { holder: sc.address(previous) }, 'before validAfter': { timestamp: sc.u64(999n) }, 'after deadline': { timestamp: sc.u64(1101n) },
  'wrong operation': { operation: xdr.ScVal.scvVec([sc.symbol('Renew')]) }, 'wrong node': { node: sc.bytes(new Uint8Array(32)) },
  'wrong generation': { generation: sc.u64(1n) }, 'wrong lease': { expires_at: sc.u64(1101n) },
})) test(`recovery rejects matching-intent receipt with ${name}`, async () => {
  const f = fixture({ record: receipt('claim', changes) }); await assert.rejects(f.holder.recoverClaim(claim));
});
test('transfer receipt must precede its exact proposal expiry', async () => {
  const f = fixture({ method: 'accept_transfer_with_destination', record: receipt('accept_transfer_with_destination', { timestamp: sc.u64(1051n) }) });
  await assert.rejects(f.holder.acceptNameTransferWithDestination(transfer), /proposal window/);
});
test('post-receipt executable must match Registry-approved Registrar code', async () => {
  const f = fixture({ hashAfter: new Uint8Array(32).fill(7) }); await assert.rejects(f.holder.recoverClaim(claim), /Registry-approved code/);
});
for (const kind of ['missing', 'other-key', 'other-contract', 'other-data-key', 'temporary', 'non-wasm'] as const) test(`post-receipt proof rejects ${kind} ledger entry`, async () => {
  const f = fixture({ entryMutation: proof => {
    if (kind === 'missing') { proof.entries.length = 0; return; }
    const entry = proof.entries[0];
    if (kind === 'other-key') { entry.key = new Contract(resolver).getFootprint(); return; }
    if (entry.val.type !== 'contractData') throw new Error('fixture');
    const original = entry.val.value;
    const data = { ext: original.ext, contract: original.contract, key: original.key, durability: original.durability, val: original.val };
    if (kind === 'other-contract') data.contract = new Contract(resolver).address().toScAddress();
    if (kind === 'other-data-key') data.key = sc.symbol('other');
    if (kind === 'temporary') data.durability = xdr.ContractDataDurability.temporary;
    if (kind === 'non-wasm') data.val = xdr.ScVal.scvContractInstance(new xdr.ScContractInstance({ executable: xdr.ContractExecutable.contractExecutableStellarAsset(), storage: null }));
    entry.val = xdr.LedgerEntryData.contractData(new xdr.ContractDataEntry(data));
  } });
  await assert.rejects(f.holder.recoverClaim(claim), /executable proof/);
});

test('recovery snapshots immutable intent before the first awaited provenance read', async () => {
  const input: ClaimIntent = { ...claim, context: { ...claim.context }, destination: { address: G, memo: { type: 'none' } } };
  let changed = false;
  const f = fixture({ onSimulate: () => {
    if (changed) return; changed = true;
    input.context.requestId = 'cd'.repeat(32); input.context.deadline = 1050n;
    input.destination.address = previous; input.feeAmount = 999n;
  } });
  assert.equal((await f.holder.recoverClaim(input))?.intentHash, nativeIntentHash('claim', claimIntentToScVal(claim)));
  assert(changed); assert.deepEqual(f.counts(), { signed: 0, submitted: 0 });
});
