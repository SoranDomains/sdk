import { Address, StrKey, hash, xdr } from "@stellar/stellar-sdk";

/** Derive independently from locally selected scheme and signed arguments. */
export function predictRegistrar(
  registry: string, node: Uint8Array, nonce: Uint8Array,
  passphrase: string, version: 0 | 1,
): string {
  if (!(node instanceof Uint8Array) || node.length !== 32 ||
      !(nonce instanceof Uint8Array) || nonce.length !== 32 ||
      (version !== 0 && version !== 1)) throw new Error("Invalid Registry deployment scheme or arguments");
  let salt = nonce;
  if (version === 1) {
    const domain = new TextEncoder().encode("soran:namespace-deploy:v1\0");
    const bound = new Uint8Array(domain.length + 65);
    bound.set(domain); bound[domain.length] = 1; // Registrar role
    bound.set(node, domain.length + 1); bound.set(nonce, domain.length + 33);
    salt = hash(bound);
  }
  const preimage = xdr.HashIdPreimage.envelopeTypeContractId(new xdr.HashIdPreimageContractId({
    networkId: hash(new TextEncoder().encode(passphrase)),
    contractIdPreimage: xdr.ContractIdPreimage.contractIdPreimageFromAddress(
      new xdr.ContractIdPreimageFromAddress({ address: new Address(registry).toScAddress(), salt }),
    ),
  }));
  return StrKey.encodeContract(hash(preimage.toXDR()));
}
