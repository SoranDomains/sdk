/** Reference handlers for an application's OWN UI. No widget, account database, keys or hidden claims. */
import { SoranHolder, createClaimIntent, parseNativeClaimIntent, stringifyNativeIntent, type PaymentDestination, type NativeClaimSubmission, type ClaimReceipt } from "@sorandomains/holder";
import { Soran } from "@sorandomains/lookup";
export type PublicPendingClaim = { intentJson: string; transactionHash: string | null };
export type RecoveryStore = {
 save(value: PublicPendingClaim): Promise<void>; load(): Promise<PublicPendingClaim | null>;
 /** Atomically archive a verified receipt and clear only this exact pending intent; preserve a newer operation. */
 archiveAndClear(expectedIntentJson: string, receipt: ClaimReceipt): Promise<boolean>;
 /** Compare-and-set: retain the SAME intent, clear only its exact hash after a proven unsigned wallet dismissal. */
 clearUnsignedHash(expectedIntentJson: string, expectedHash: string): Promise<boolean>;
};

export class SignupNames {
 constructor(private holder: SoranHolder, private lookup: Soran, private recovery: RecoveryStore,
  /** Adapter-specific proof: true ONLY for a positive wallet refusal before any signature was produced. Never generic errors/timeouts. */
  private isUnsignedWalletDismissal: (error: unknown) => boolean = () => false) {}
 /** Call from an explicit "Choose username" action after app sign-in and verified wallet linking. */
 async review(name: string, destination: PaymentDestination) {
  const pending = await this.recovery.load();
  if (pending) throw new Error("Resume the existing claim before reviewing a replacement");
  const quote = await this.holder.claimQuote(name);
  const random = crypto.getRandomValues(new Uint8Array(32));
  const requestId = Array.from(random, b => b.toString(16).padStart(2,"0")).join("");
  const ttl = quote.config?.settings.admission.type === "approval" ? quote.config.settings.approvalTtlSecs : 300n;
  const intent = createClaimIntent(quote, destination, { requestId, deadline: quote.now + (ttl < 300n ? ttl : 300n) });
  const intentJson = stringifyNativeIntent(intent);
  await this.recovery.save({ intentJson, transactionHash: null });
  // Show exact username fee (feeAmount is stroops), destination+memo, network and owner rules in YOUR review UI.
  return { quote, intentJson };
 }
 /** App-approved mode first obtains its bounded native auth entry from the app's own service.
  * A private app session and linked-wallet proof are prerequisites for that service, not contract authority. */
 async prepareAdmission() {
  const pending = await this.recovery.load(); if (!pending) throw new Error("No reviewed claim");
  const intent = parseNativeClaimIntent(pending.intentJson);
  const built = await this.holder.buildClaim(intent);
  if (!built.plan.eligibility) throw new Error("This reviewed claim does not use app approval");
  return built;
 }
 /** Trigger only from the explicit wallet confirmation button; never run during routine sign-in. */
 async submit(proof: readonly string[] = [], eligibilityAuthorization?: string): Promise<NativeClaimSubmission> {
  const pending = await this.recovery.load(); if (!pending) throw new Error("No reviewed claim");
  const intent = parseNativeClaimIntent(pending.intentJson);
  if (pending.transactionHash) throw new Error("Transaction already submitted or signed; resume original receipt/hash before retrying");
  let preparedHash: string | null = null;
  try {
   return await this.holder.claim(intent, { proof, eligibilityAuthorization, onPrepared: async prepared => {
    await this.recovery.save({ intentJson: pending.intentJson, transactionHash: prepared.hash }); preparedHash = prepared.hash;
   } });
  } catch (error) {
   // The SDK never broadcasts before signTransaction returns. The adapter must be sign-only and positively know refusal.
   if (preparedHash && this.isUnsignedWalletDismissal(error)) await this.recovery.clearUnsignedHash(pending.intentJson, preparedHash);
   throw error;
  }
 }
 /** Safe after reload, sign-in or RPC interruption. A null receipt is not proof of failure. */
 async resume() {
  const pending = await this.recovery.load(); if (!pending) return { state: "no-local-request" as const };
  const receipt = await this.holder.recoverClaim(parseNativeClaimIntent(pending.intentJson));
  return receipt ? { state: "historically-completed" as const, receipt } : { state: "unresolved" as const, reference: pending };
 }
 /** Explicit completion action: persist verified history and unlock future username choices without erasing a newer request. */
 async finalizeCompleted() {
  const pending = await this.recovery.load(); if (!pending) return { archived: false };
  const receipt = await this.holder.recoverClaim(parseNativeClaimIntent(pending.intentJson));
  if (!receipt) throw new Error("Original claim is unresolved; keep its recovery reference");
  return { archived: await this.recovery.archiveAndClear(pending.intentJson, receipt), receipt };
 }
 /** Existing holders are linked assets, not private app account IDs. The app separately proves wallet control. */
 async verifyExistingName(name: string, linkedWallet: string) {
  const metadata = await this.lookup.nameMetadata(name);
  if (!metadata || metadata.holder !== linkedWallet || !metadata.active) throw new Error("Linked wallet does not currently hold an active name");
  const payment = await this.lookup.resolvePayment(name);
  return { name, holder: linkedWallet, generation: metadata.generation, payment };
 }
}
