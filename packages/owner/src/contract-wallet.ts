import { Address, buildAuthorizationEntryPreimage, hash, xdr } from "@stellar/stellar-sdk";
import { NativeClaimError, address, u32 } from "./native-codec.js";

/** The wallet defines its signature format and retains custody of its keys.
 * Soran supplies the exact reviewed invocation, network, nonce and expiry.
 * A separate G-account TxSigner submits the resulting transaction.
 */
export type ContractWallet = {
  address: string;
  signAuthorization(request: {
    address: string;
    networkPassphrase: string;
    authorizationEntryXdr: string;
    signaturePayload: Uint8Array;
  }): Promise<xdr.ScVal>;
};
export type ContractAuthorization = {
  account: string;
  latestLedger: number;
  maxExpirationLedger: number;
};

export function validateContractAuthorization(entry: xdr.SorobanAuthorizationEntry, expected: ContractAuthorization, signed: boolean): void {
  address(expected.account, "contract", "contract wallet");
  u32(expected.latestLedger, "latest ledger");
  u32(expected.maxExpirationLedger, "maximum authorization ledger");
  if (expected.latestLedger < 1 || expected.maxExpirationLedger <= expected.latestLedger)
    throw new NativeClaimError("contract authorization ledger window is invalid", "authorization");
  if (entry.credentials.type !== "sorobanCredentialsAddress" ||
      Address.fromScAddress(entry.credentials.address.address).toString() !== expected.account)
    throw new NativeClaimError("authorization does not belong to the selected contract wallet", "authorization");
  const c = entry.credentials.address;
  if (signed) {
    if (c.signatureExpirationLedger <= expected.latestLedger || c.signatureExpirationLedger > expected.maxExpirationLedger ||
        c.signature.toXDR().length > 16384)
      throw new NativeClaimError("contract authorization is expired or outside the reviewed limits", "authorization");
    // A contract can legitimately accept any ScVal, including Void. Only an
    // enforcing simulation and the host's __check_auth establish validity.
  } else if (c.signature.type !== "scvVoid" && !(c.signature.type === "scvVec" && !c.signature.vec?.length)) {
    throw new NativeClaimError("refusing to sign an already signed contract authorization", "authorization");
  }
}

/** Invocation scope must be validated by the caller before calling this helper. */
export async function signContractAuthorization(
  unsigned: xdr.SorobanAuthorizationEntry, expected: ContractAuthorization,
  wallet: ContractWallet, networkPassphrase: string,
): Promise<xdr.SorobanAuthorizationEntry> {
  validateContractAuthorization(unsigned, expected, false);
  if (wallet.address !== expected.account || !networkPassphrase)
    throw new NativeClaimError("contract wallet or network differs from the reviewed authorization", "authorization");
  // Round-trip before yielding to a wallet. Its callback receives no mutable
  // invocation objects and can supply only the contract-defined signature.
  const entry = xdr.SorobanAuthorizationEntry.fromXDR(unsigned.toXDR());
  const c = entry.credentials;
  if (c.type !== "sorobanCredentialsAddress") throw new NativeClaimError("missing contract credential");
  const preimage = buildAuthorizationEntryPreimage(entry, expected.maxExpirationLedger, networkPassphrase);
  const credentials = new xdr.SorobanAddressCredentials({
    ...c.address, signatureExpirationLedger: expected.maxExpirationLedger, signature: xdr.ScVal.scvVoid(),
  });
  const signingEntry = new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(credentials), rootInvocation: entry.rootInvocation,
  });
  const signature = await wallet.signAuthorization({
    address: expected.account, networkPassphrase, authorizationEntryXdr: signingEntry.toXDR("base64"),
    signaturePayload: Uint8Array.from(hash(preimage.toXDR())),
  });
  if (wallet.address !== expected.account) throw new NativeClaimError("contract wallet changed while authorizing", "authorization");
  const signed = new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(new xdr.SorobanAddressCredentials({
      ...credentials, signature: xdr.ScVal.fromXDR(signature.toXDR()),
    })), rootInvocation: entry.rootInvocation,
  });
  validateContractAuthorization(signed, expected, true);
  return signed;
}
