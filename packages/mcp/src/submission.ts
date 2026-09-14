import { TransactionBuilder } from "@stellar/stellar-sdk";
import { ApiHttpError } from "./http.js";

export type SubmissionResult = {
  ok: boolean;
  txHash: string;
  pending?: true;
  detail?: string;
  registrarId?: unknown;
};

/** The exact signed transaction is the recovery identity, even when the API
 * response is lost. Authentication and scope selection happen before dispatch
 * reaches this boundary; their failure is not an attempted submission. */
export async function submitWithRecovery(
  signedXdr: string,
  passphrase: string,
  dispatch: () => Promise<unknown>,
): Promise<SubmissionResult> {
  const txHash = Buffer.from(TransactionBuilder.fromXDR(signedXdr, passphrase).hash()).toString("hex");
  const unresolved = (detail: string): SubmissionResult => ({ ok: false, pending: true, txHash, detail });
  try {
    const response = await dispatch();
    const value = response && typeof response === "object" ? response as Record<string, unknown> : null;
    if (!value || (value.txHash !== undefined && value.txHash !== txHash))
      return unresolved("The API response did not identify the exact signed transaction. Check this transaction hash before attempting another transaction.");
    if (value.ok === true && value.txHash === txHash)
      return { ok: true, txHash, registrarId: value.registrarId };
    if (value.ok === false && value.pending === true)
      return unresolved(typeof value.detail === "string" ? value.detail : "Submitted; confirmation is pending.");
    return unresolved("The API did not return a conclusive submission result. Check this transaction hash before attempting another transaction.");
  } catch (error) {
    // Authentication runs before the API relay. Its one explicit 401 retry is
    // handled by the private-session coordinator, using the same signed bytes.
    if (error instanceof ApiHttpError && error.status === 401) throw error;
    // Other explicit client refusals are errors, never a pending success. Keep
    // the hash for inspection: deployment attestation can refuse after a send.
    if (error instanceof ApiHttpError && error.status >= 400 && error.status < 500 && error.status !== 408)
      throw Object.assign(error, { txHash, kind: "rejected" });
    return unresolved("The API response was interrupted or unavailable. This transaction may have been submitted. Check this exact hash before attempting another transaction.");
  }
}
