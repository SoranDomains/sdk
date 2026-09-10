import { Transaction, TransactionBuilder } from "@stellar/stellar-sdk";

export function networkFeeLimit(options: { maxNetworkFeeStroops?: bigint; maxNativeFeeStroops?: bigint }): bigint {
  const total = options.maxNetworkFeeStroops ?? options.maxNativeFeeStroops ?? 50_000_000n;
  for (const limit of [total, options.maxNativeFeeStroops ?? total]) {
    if (typeof limit !== "bigint" || limit <= 0n || limit > 4_294_967_295n)
      throw new Error("maximum network fee must be a bigint between 1 and 4294967295 stroops");
  }
  return total;
}

export function assertFeeLimit(transaction: Transaction, maximum: bigint): void {
  if (!/^[1-9][0-9]*$/.test(transaction.fee) || BigInt(transaction.fee) > maximum)
    throw new Error(`network fee ${transaction.fee} stroops exceeds the operator maximum ${maximum} stroops`);
  const now = BigInt(Math.floor(Date.now() / 1000));
  const bounds = transaction.timeBounds;
  if (!bounds || BigInt(bounds.maxTime) <= now || BigInt(bounds.maxTime) > now + 300n || BigInt(bounds.minTime) > now)
    throw new Error("transaction must be valid now and expire within five minutes");
}

type Signer = {
  publicKey(): string | Promise<string>;
  signTransaction(encoded: string, options: { networkPassphrase: string }): Promise<string | { signedTxXdr: string }>;
};

/** Keep the local operator's ceiling even when an installed SDK predates it. */
export function feeBoundSigner(signer: Signer, maximum: bigint): Signer {
  return {
    publicKey: () => signer.publicKey(),
    signTransaction: async (encoded, options) => {
      const transaction = TransactionBuilder.fromXDR(encoded, options.networkPassphrase);
      if (!(transaction instanceof Transaction)) throw new Error("unexpected fee-bump signing request");
      assertFeeLimit(transaction, maximum);
      return signer.signTransaction(encoded, options);
    },
  };
}
