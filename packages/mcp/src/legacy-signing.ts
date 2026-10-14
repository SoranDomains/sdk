import { Transaction, TransactionBuilder } from "@stellar/stellar-sdk";

type Signer = {
  publicKey(): string | Promise<string>;
  signTransaction(encoded: string, options: { networkPassphrase: string }): Promise<string | { signedTxXdr: string }>;
};

/**
 * Defense at the actual signer used by installed legacy SDKs, including releases
 * that predate SR-01. Legacy writes authorize one root and no child calls;
 * permissionless subname upkeep authorizes nothing. Native claims and transfers
 * use separate clients and their SDK's exact, locally derived authorization plan.
 */
export function legacyBoundSigner(signer: Signer): Signer {
  return {
    publicKey: () => signer.publicKey(),
    signTransaction: async (encoded, options) => {
      const tx = TransactionBuilder.fromXDR(encoded, options.networkPassphrase);
      const source = await signer.publicKey();
      if (!(tx instanceof Transaction) || tx.source !== source || tx.operations.length !== 1)
        throw new Error("legacy signing requires the selected source and exactly one operation");
      const op = tx.operations[0];
      if (op.source !== undefined && op.source !== source)
        throw new Error("legacy signing requires the selected operation source");
      // Restoration has no invocation authorization; the enclosing fee signer
      // still enforces the operator's ceiling and finite validity window.
      if (op.type !== "restoreFootprint") {
        if (op.type !== "invokeHostFunction" || op.func.type !== "hostFunctionTypeInvokeContract")
          throw new Error("legacy signing requires a contract invocation");
        const call = op.func.invokeContract;
        const entries = op.auth ?? [];
        if (["touch_subname", "touch_subname_page"].includes(call.functionName.toString())) {
          if (entries.length) throw new Error("permissionless upkeep must not require authorization");
        } else {
          if (entries.length !== 1 || entries[0].credentials.type !== "sorobanCredentialsSourceAccount")
            throw new Error("legacy signing requires exactly one source-account authorization");
          const root = entries[0].rootInvocation;
          if (root.function.type !== "sorobanAuthorizedFunctionTypeContractFn" || root.subInvocations.length ||
              root.function.contractFn.toXDR("base64") !== call.toXDR("base64"))
            throw new Error("legacy authorization differs from the selected call (unexpected nested authorization)");
        }
      }
      return signer.signTransaction(encoded, options);
    },
  };
}
