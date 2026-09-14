import { Account, Address, Contract, StrKey, TransactionBuilder, rpc, xdr } from "@stellar/stellar-sdk";

/** A failed read must never be mistaken for permission to deploy a replacement. */
export class ResolverReadUnavailable extends Error {}

/** Read the selected Registry directly. No API hints, signing, or submission. */
export async function namespaceResolverState(options: {
  registry: string; node: Uint8Array; wallet: string; passphrase: string; rpcUrl: string;
  expectedResolver?: string;
}): Promise<{ registrar: string; resolver: string | null }> {
  const { registry, node, wallet, passphrase, expectedResolver } = options;
  if (!StrKey.isValidContract(registry)) throw new Error("Resolver setup requires a locally pinned Registry");
  const server = new rpc.Server(options.rpcUrl, { timeout: 10000 });
  const nodeArg = xdr.ScVal.scvBytes(node);
  async function read(method: string): Promise<xdr.ScVal> {
    const tx = new TransactionBuilder(new Account(wallet, "0"), { fee: "100", networkPassphrase: passphrase })
      .addOperation(new Contract(registry).call(method, nodeArg)).setTimeout(60).build();
    let result;
    try { result = await server.simulateTransaction(tx, undefined, undefined, false); }
    catch { throw new ResolverReadUnavailable(`Registry ${method} read is unavailable; no deployment state was inferred.`); }
    if (rpc.Api.isSimulationError(result) || rpc.Api.isSimulationRestore(result) || !rpc.Api.isSimulationSuccess(result) || !result.result)
      throw new ResolverReadUnavailable(`Registry ${method} could not be verified; no deployment state was inferred.`);
    return result.result.retval;
  }
  function address(value: xdr.ScVal, optional = false): string | null {
    if (optional && value.type === "scvVoid") return null;
    if (value.type !== "scvAddress") throw new Error("Registry returned an invalid address");
    return Address.fromScVal(value).toString();
  }
  const [ownerValue, registrarValue, resolverValue, attestedValue] = await Promise.all([
    read("owner_of"), read("registrar_of"), read("resolver_of"), read("attested_resolver_of"),
  ]);
  if (address(ownerValue, true) !== wallet) throw new Error("This wallet does not own the selected namespace");
  const registrar = address(registrarValue, true);
  if (!registrar || !StrKey.isValidContract(registrar)) throw new Error("Activate the namespace Registrar with activate_namespace before deploying its Resolver");
  const resolver = address(resolverValue, true), attested = address(attestedValue, true);
  if (!resolver && !attested) return { registrar, resolver: null };
  if (!attested || resolver !== attested)
    throw new Error(`The selected Resolver differs from its Registry attestation. Review namespace resolution settings${attested ? ` and restore the attested Resolver ${attested} with set_resolver` : ""}; do not deploy a replacement.`);
  if (!StrKey.isValidContract(resolver!)) throw new Error("Registry returned an invalid Resolver contract");
  if (expectedResolver && resolver !== expectedResolver) throw new Error("The on-chain Resolver differs from the prepared deployment");
  // This Registry method checks clean factory attestation, selected pointer and
  // both executable hashes against governed native code. Clean attestation
  // proves the Registrar anchors and Resolver authority/provenance at genesis.
  const native = await read("native_contracts");
  if (native.type !== "scvVec" || native.vec?.length !== 2 ||
      address(native.vec[0]) !== registrar || address(native.vec[1]) !== resolver)
    throw new Error("Registry did not verify the selected native Registrar and Resolver");
  return { registrar, resolver };
}
