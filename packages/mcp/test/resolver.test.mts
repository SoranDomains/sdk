import assert from 'node:assert/strict';
import test from 'node:test';
import { Account, Address, Keypair, Networks, Operation, SorobanDataBuilder, StrKey, TransactionBuilder, rpc, scValToNative, xdr } from '@stellar/stellar-sdk';
import { Soran } from '@sorandomains/lookup';
import { registerWriteTools } from '../src/tools.js';
import { predictRegistrar, predictResolver } from '../src/deployment.js';

const registry = 'CDSORANCV3IFF3MKHJ7KI4MKEJOJZFMTDVAZCD5XFOR4WTGNXJJNOKQE';
const node = Buffer.from('857f994cc3975eda4e373f51c9f5b0f7940451a5eb3ff225edc5cd468228b430', 'hex');
const nonce = Buffer.from('6d6bc23d8aca511dfeccda08bbc456c55de87f20238b1119e267420100000000', 'hex');
const resolver = 'CCSORANQSCWQXIVDGERI4QRNQS2OB4RRDR7AHABNOJ57Z23JUFQOVCDU';
const registrar = StrKey.encodeContract(Buffer.alloc(32, 8));
const ordinary = StrKey.encodeContract(Buffer.alloc(32, 9));
const key = Keypair.random(), wallet = key.publicKey();
const args = { namespace: 'nova', maxNetworkFeeStroops: '10000' };
const decode = (result: any) => JSON.parse(result.content[0].text);
const addr = (s: string | null) => s ? new Address(s).toScVal() : xdr.ScVal.scvVoid();
const inv = (contract: string, method: string, values: xdr.ScVal[], children: xdr.SorobanAuthorizedInvocation[] = []) => new xdr.SorobanAuthorizedInvocation({function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(new xdr.InvokeContractArgs({contractAddress: new Address(contract).toScAddress(), functionName: method, args: values})), subInvocations: children});
function prepared(options: { contract?: string; method?: string; values?: xdr.ScVal[]; fee?: string; children?: xdr.SorobanAuthorizedInvocation[]; source?: string; timeout?: number; extra?: boolean; auth?: boolean } = {}) {
  const { contract = registry, method = 'deploy_resolver', values = [xdr.ScVal.scvBytes(node), xdr.ScVal.scvBytes(nonce)], fee = '1000', children = [], source = wallet, timeout = 60 } = options;
  const auth = new xdr.SorobanAuthorizationEntry({credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(), rootInvocation: inv(contract, method, values, children)});
  const builder = new TransactionBuilder(new Account(source, '7'), { fee, networkPassphrase: Networks.TESTNET }).addOperation(Operation.invokeContractFunction({ contract, function: method, args: values, auth: options.auth === false ? [] : [auth] }));
  if (options.extra) builder.addOperation(Operation.manageData({name: 'unwanted', value: 'x'}));
  return builder.setTimeout(timeout).build().toXDR();
}
async function fixture(t: any, options: {version?: 0 | 1 | null; maxFee?: string} = {}) {
  const handlers = new Map<string, (args: any) => Promise<any>>();
  const state = { owner: wallet as string | null, registrar: registrar as string | null, resolver: null as string | null, attested: null as string | null,
    native: true, unavailable: false, reads: [] as string[], requests: [] as string[], selected: '', sends: [] as string[], logins: 0,
    expire: '', lose: '', afterSubmit: undefined as undefined | (() => void),
    prep: {namespace: 'nova', network: Networks.TESTNET, predictedId: resolver, xdr: prepared()} as Record<string, any> };
  const originalFetch = globalThis.fetch, originalSimulate = rpc.Server.prototype.simulateTransaction;
  t.after(() => {globalThis.fetch = originalFetch; rpc.Server.prototype.simulateTransaction = originalSimulate;});
  rpc.Server.prototype.simulateTransaction = async tx => {
    assert.equal(tx.signatures.length, 0, 'state probes never sign');
    const call = (tx.operations[0] as any).func.invokeContract;
    assert.equal(Address.fromScAddress(call.contractAddress).toString(), registry);
    assert.deepEqual(Buffer.from(scValToNative(call.args[0])), node);
    const fn = call.functionName.toString(); state.reads.push(fn);
    if (state.unavailable) throw new Error('RPC disconnected');
    if (fn === 'native_contracts' && !state.native) return {error: 'native verification failed', latestLedger: 1} as any;
    const retval = fn === 'owner_of' ? addr(state.owner) : fn === 'registrar_of' ? addr(state.registrar) : fn === 'resolver_of' ? addr(state.resolver) : fn === 'attested_resolver_of' ? addr(state.attested) : xdr.ScVal.scvVec([addr(state.registrar), addr(state.resolver)]);
    return {id: 'fixture', latestLedger: 1, minResourceFee: '0', transactionData: new SorobanDataBuilder(), result: {auth: [], retval}, events: []} as any;
  };
  globalThis.fetch = async (url, opts) => {
    const path = new URL(String(url)).pathname, body = JSON.parse(String(opts?.body ?? '{}'));
    state.requests.push(path);
    if (path.endsWith('/challenge')) return Response.json({challengeId: 'fixture', network: Networks.TESTNET, xdr: new TransactionBuilder(new Account(wallet, '0'), {fee: '100', networkPassphrase: Networks.TESTNET}).addOperation(Operation.manageData({name: 'soran.domains auth', value: 'fixture'})).setTimeout(300).build().toXDR()});
    if (path.endsWith('/verify')) {state.logins++; return Response.json({token: 'fixture-' + state.logins});}
    if (path === '/console/session/namespace') {state.selected = body.namespace; return Response.json({ok: true, namespace: body.namespace});}
    assert.equal(body.namespace, 'nova'); assert.equal(state.selected, body.namespace);
    assert.equal(new Headers(opts?.headers).get('X-Soran-Namespace'), body.namespace);
    if (path === state.expire) {state.expire = ''; return Response.json({error: 'expired'}, {status: 401});}
    if (path.endsWith('/prepare')) return Response.json(state.prep);
    assert.equal(path, '/console/resolver/deploy/submit');
    const tx = TransactionBuilder.fromXDR(body.signedXdr, Networks.TESTNET) as any;
    assert.equal(tx.signatures.length, 1);
    const hash = Buffer.from(tx.hash()).toString('hex'); state.sends.push(hash);
    state.resolver = state.attested = state.prep.predictedId;
    state.afterSubmit?.();
    if (state.lose === 'transport') throw new TypeError('response lost');
    if (state.lose === 'json') return new Response('{');
    if (state.lose === '500') return Response.json({error: 'unknown'}, {status: 500});
    return Response.json({ok: state.lose !== 'pending', pending: state.lose === 'pending', txHash: state.lose === 'wrong_hash' ? '0'.repeat(64) : hash, resolverId: ordinary});
  };
  await registerWriteTools({tool(name: string, _d: string, _s: any, cb: any) {handlers.set(name, cb);}} as never,
    {secret: key.secret(), registryId: registry, registryDeploymentSaltVersion: options.version === null ? undefined : options.version ?? 1, hintUrl: 'https://fixture.invalid', maxNetworkFeeStroops: options.maxFee === undefined ? undefined : BigInt(options.maxFee)});
  return {state, deploy: () => handlers.get('deploy_namespace_resolver')!(args), confirm: (extra: any = {}) => handlers.get('confirm_namespace_resolver')!({namespace: 'nova', ...extra})};
}

test('Resolver role prediction matches the independently mined historical deployment', async () => {
  assert.deepEqual(Buffer.from(await new Soran().namehash('nova')), node);
  assert.equal(predictResolver(registry, node, nonce, Networks.TESTNET, 1), resolver);
  assert.notEqual(predictRegistrar(registry, node, nonce, Networks.TESTNET, 1), resolver);
  assert.notEqual(predictResolver(registry, Buffer.alloc(32), nonce, Networks.TESTNET, 1), resolver);
  assert.notEqual(predictResolver(registry, node, nonce, Networks.PUBLIC, 1), resolver);
  assert.notEqual(predictResolver(registry, node, nonce, Networks.TESTNET, 0), resolver);
});
test('Resolver setup signs one exact factory call and independently verifies the selected binding', async t => {
  const f = await fixture(t), result = await f.deploy(), body = decode(result);
  assert.notEqual(result.isError, true, result.content[0].text);
  assert.equal(body.resolverReady, true); assert.equal(body.resolver, resolver);
  assert.equal(body.txHash, f.state.sends[0]); assert.equal(body.onchainTransactionSubmitted, true);
  assert.equal(f.state.sends.length, 1); assert.ok(f.state.reads.includes('native_contracts'));
});
test('Already attested ordinary Resolver is accepted without authentication, preparation or signing', async t => {
  const f = await fixture(t); f.state.resolver = f.state.attested = ordinary;
  const result = await f.deploy(); assert.notEqual(result.isError, true, result.content[0].text);
  assert.equal(decode(result).resolver, ordinary); assert.equal(decode(result).alreadyConfigured, true);
  assert.equal(decode(result).onchainTransactionSubmitted, false); assert.deepEqual(f.state.requests, []);
});
for (const condition of ['missing_registrar', 'not_owner', 'cleared', 'different', 'unattested', 'tainted', 'unavailable']) test(`Resolver setup refuses ${condition} without preparing a replacement`, async t => {
  const f = await fixture(t);
  if (condition === 'missing_registrar') f.state.registrar = null;
  if (condition === 'not_owner') f.state.owner = Keypair.random().publicKey();
  if (condition === 'cleared') f.state.attested = ordinary;
  if (condition === 'different') {f.state.attested = ordinary; f.state.resolver = resolver;}
  if (condition === 'unattested') f.state.resolver = ordinary;
  if (condition === 'tainted') {f.state.resolver = f.state.attested = ordinary; f.state.native = false;}
  if (condition === 'unavailable') f.state.unavailable = true;
  assert.equal((await f.deploy()).isError, true); assert.deepEqual(f.state.requests, []);
});
test('Vanity queue reports no submission and retries setup; malformed queue responses fail', async t => {
  const f = await fixture(t); f.state.prep = {namespace: 'nova', pending: true, vanity: {status: 'mining'}, retryAfterMs: 2000};
  const result = await f.deploy(); assert.equal(decode(result).pending, true); assert.equal(decode(result).onchainTransactionSubmitted, false);
  assert.match(decode(result).nextStep, /deploy_namespace_resolver/); assert.deepEqual(f.state.sends, []);
  f.state.prep.namespace = 'other'; assert.equal((await f.deploy()).isError, true);
});
for (const [title, change] of Object.entries({
  'wrong namespace': (s: any) => {s.prep.namespace = 'other';},
  'wrong network': (s: any) => {s.prep.network = Networks.PUBLIC;},
  'wrong role': (s: any) => {s.prep.predictedId = predictRegistrar(registry, node, nonce, Networks.TESTNET, 1);},
  'different node': (s: any) => {s.prep.xdr = prepared({values: [xdr.ScVal.scvBytes(Buffer.alloc(32)), xdr.ScVal.scvBytes(nonce)]});},
  'short nonce': (s: any) => {s.prep.xdr = prepared({values: [xdr.ScVal.scvBytes(node), xdr.ScVal.scvBytes(Buffer.alloc(31))]});},
  'fee above requested ceiling': (s: any) => {s.prep.xdr = prepared({fee: '10001'});},
  'foreign source': (s: any) => {s.prep.xdr = prepared({source: Keypair.random().publicKey()});},
  'foreign contract': (s: any) => {s.prep.xdr = prepared({contract: ordinary});},
  'wrong method': (s: any) => {s.prep.xdr = prepared({method: 'set_resolver'});},
  'extra operation': (s: any) => {s.prep.xdr = prepared({extra: true});},
  'nested authorization': (s: any) => {s.prep.xdr = prepared({children: [inv(ordinary, 'evil', [])]});},
  'missing authorization': (s: any) => {s.prep.xdr = prepared({auth: false});},
  'unbounded transaction': (s: any) => {s.prep.xdr = prepared({timeout: 0});},
  'ordinary new v1 address': (s: any) => {const n = Buffer.alloc(32); s.prep.predictedId = predictResolver(registry, node, n, Networks.TESTNET, 1); s.prep.xdr = prepared({values: [xdr.ScVal.scvBytes(node), xdr.ScVal.scvBytes(n)]});},
})) test(`Resolver signer rejects ${title}`, async t => {
  const f = await fixture(t); change(f.state); const result = await f.deploy();
  assert.equal(result.isError, true, result.content[0].text); assert.deepEqual(f.state.sends, []); assert.equal(decode(result).txHash, undefined);
});
test('Custom deployment requires a local scheme and honors both fee ceilings', async t => {
  const f = await fixture(t, {version: null}); assert.equal((await f.deploy()).isError, true); assert.deepEqual(f.state.requests, []);
});
test('Tool cannot raise the operator network fee ceiling', async t => {
  const f = await fixture(t, {maxFee: '500'}); assert.equal((await f.deploy()).isError, true); assert.deepEqual(f.state.sends, []);
});
test('Explicit legacy scheme can deploy an ordinary address', async t => {
  const f = await fixture(t, {version: 0}); f.state.prep.predictedId = predictResolver(registry, node, nonce, Networks.TESTNET, 0);
  const result = await f.deploy(); assert.notEqual(result.isError, true, result.content[0].text); assert.equal(decode(result).resolverReady, true);
});
for (const mode of ['transport', 'json', 'wrong_hash', '500', 'pending']) test(`Resolver ${mode} response preserves exact recovery identifiers`, async t => {
  const f = await fixture(t); f.state.lose = mode;
  const result = await f.deploy(), body = decode(result); assert.notEqual(result.isError, true, result.content[0].text);
  assert.equal(body.pending, true); assert.equal(body.resolverReady, false); assert.equal(body.predictedId, resolver); assert.equal(body.txHash, f.state.sends[0]);
  const requests = f.state.requests.length;
  const confirmation = await f.confirm(body); assert.equal(decode(confirmation).resolverReady, true); assert.equal(decode(confirmation).onchainTransactionSubmitted, false);
  assert.equal(f.state.sends.length, 1); assert.equal(f.state.requests.length, requests);
});
for (const step of ['prepare', 'submit']) test(`Resolver ${step} renews and reselects namespace after 401`, async t => {
  const f = await fixture(t); f.state.expire = `/console/resolver/deploy/${step}`;
  const result = await f.deploy(); assert.equal(decode(result).resolverReady, true, result.content[0].text); assert.equal(f.state.logins, 2); assert.equal(f.state.sends.length, 1);
});
test('Confirmation keeps pending identifiers on absent/unavailable state and rejects a different binding', async t => {
  const f = await fixture(t), original = {predictedId: resolver, txHash: 'a'.repeat(64)};
  for (const unavailable of [false, true]) {f.state.unavailable = unavailable; const body = decode(await f.confirm(original)); assert.equal(body.pending, true); assert.equal(body.txHash, original.txHash); assert.equal(body.predictedId, resolver);}
  f.state.unavailable = false; f.state.resolver = f.state.attested = ordinary;
  const mismatch = await f.confirm(original); assert.equal(mismatch.isError, true); assert.equal(decode(mismatch).txHash, original.txHash);
  assert.equal(decode(await f.confirm()).resolverReady, true); assert.deepEqual(f.state.requests, []);
});
test('Relay success cannot mask an unverified native binding', async t => {
  const f = await fixture(t); f.state.afterSubmit = () => {f.state.native = false;};
  const result = await f.deploy(); assert.equal(decode(result).pending, true); assert.equal(decode(result).resolverReady, false); assert.equal(decode(result).txHash, f.state.sends[0]);
});
