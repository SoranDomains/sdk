import { Contract, scValToNative, xdr, type rpc } from '@stellar/stellar-sdk';
import { NativeClaimError, address, bytes32, exactObject, hex, sc, u32, unhex } from './native-codec.js';
type Context = {
  registryId: string;
  server: Pick<rpc.Server, 'getLedgerEntries'>;
  read(contract: string, method: string, args: xdr.ScVal[]): Promise<unknown>;
  readWithLedger?(contract: string, method: string, args: xdr.ScVal[]): Promise<{ value: unknown; ledger: number }>;
};
function fail(message: string): never { throw new NativeClaimError(`Registry code policy: ${message}`, 'unavailable'); }
function ledger(value: unknown, minimum: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value < 1 || value > 0xffffffff) fail('missing or stale ledger context');
  return value;
}
/** Select policy from an exact Registry instance proof. Failed RPC/method reads
 * never downgrade governed verification to the historical template rule. */
export async function expectedRegistrarCode(context: Context, namespace: string, minimumLedger?: number): Promise<string> {
  const key = new Contract(context.registryId).getFootprint();
  const proof = await context.server.getLedgerEntries(key);
  const observed = ledger(proof?.latestLedger, minimumLedger ?? 1);
  const entry = proof.entries?.[0];
  if (proof.entries?.length !== 1 || !entry || entry.key.toXDR('base64') !== key.toXDR('base64') || entry.val.type !== 'contractData') fail('missing or mismatched instance');
  const data = entry.val.value;
  if (data.contract.toXDR('base64') !== new Contract(context.registryId).address().toScAddress().toXDR('base64') || data.key.type !== 'scvLedgerKeyContractInstance' || data.durability !== xdr.ContractDataDurability.persistent || data.val.type !== 'scvContractInstance' || data.val.value.executable.type !== 'contractExecutableWasm') fail('invalid Registry Wasm instance');
  const storage = data.val.value.storage;
  if (storage !== null && !Array.isArray(storage)) fail('malformed instance storage');
  const authorityKey = xdr.ScVal.scvVec([xdr.ScVal.scvSymbol('AuthorityV1')]).toXDR('base64');
  const authorities = (storage ?? []).filter(row => row.key.toXDR('base64') === authorityKey);
  if (authorities.length > 1) fail('duplicate authority');
  const read = async (method: string, args: xdr.ScVal[] = []): Promise<unknown> => {
    if (minimumLedger === undefined) return context.read(context.registryId, method, args);
    if (!context.readWithLedger) fail('fresh policy reader unavailable');
    const result = await context.readWithLedger(context.registryId, method, args);
    ledger(result?.ledger, Math.max(observed, minimumLedger));
    return result.value;
  };
  if (authorities.length === 0) {
    const templates = await read('template_hashes');
    if (!Array.isArray(templates) || templates.length !== 2) fail('malformed historical templates');
    return hex(bytes32(templates[0], 'Registry Registrar template'));
  }
  if (authorities[0].val.type !== 'scvAddress') fail('malformed upgrade authority');
  address(scValToNative(authorities[0].val), 'identity', 'Registry upgrade authority');
  if (await read('upgrade_policy_version') !== 1) fail('unsupported governed policy');
  const code = exactObject(await read('native_code', [sc.bytes(unhex(namespace))]), ['registrar','resolver','registrar_updates','resolver_updates'], 'native code');
  u32(code.registrar_updates, 'Registrar upgrade count'); u32(code.resolver_updates, 'Resolver upgrade count');
  bytes32(code.resolver, 'Registry Resolver code');
  return hex(bytes32(code.registrar, 'Registry Registrar code'));
}
