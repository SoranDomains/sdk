import {
  Address,
  Contract,
  Operation,
  Transaction,
  TransactionBuilder,
  authorizeEntry,
  rpc,
  nativeToScVal,
  xdr,
} from "@stellar/stellar-sdk";
import { FundingReader } from "./funding-reader.js";
import {
  FundingError,
  sponsorIntentHash,
  sponsorQuoteToScVal,
  sponsoredIdentityToScVal,
  type SponsorQuote,
  type SponsoredIdentityIntent,
} from "./funding-types.js";
import {
  claimIntentToScVal,
  claimLabelToScVal,
  claimQuoteFromNative,
  type ClaimIntent,
} from "./native-types.js";
import {
  address,
  paymentDestinationToScVal,
  sc,
  unhex,
} from "./native-codec.js";
import {
  authorizedInvocation,
  validateEligibilityAuthorization,
  type NativeInvocation,
} from "./native-auth.js";

export type SponsorRequest = {
  quote: SponsorQuote;
  intent: ClaimIntent | SponsoredIdentityIntent;
  proof?: readonly string[];
};
export type SponsorPlan = {
  request: SponsorRequest;
  method: string;
  args: xdr.ScVal[];
  actorInvocation: NativeInvocation;
  relayerInvocation: NativeInvocation;
  eligibility?: {
    account: string;
    invocation: NativeInvocation;
    latestLedger: number;
    maxExpirationLedger: number;
  };
  maxNetworkFee: bigint;
};

/** Build from the app's reviewed intent and pinned shared contracts, never a remote invocation tree. */
export function sponsorPlan(
  request: SponsorRequest,
  lookup: string,
  primary: string,
  maxNetworkFee: bigint,
  eligibilityAccount?: string,
): SponsorPlan {
  const { quote: q, intent } = request;
  const method = "sponsor_" + q.action;
  if (
    q.intentHash !== sponsorIntentHash(q.action, intent) ||
    maxNetworkFee <= 0n
  )
    throw new FundingError(
      "Quote differs from the requested action",
      "authorization",
    );
  let args: xdr.ScVal[], target: NativeInvocation;
  if (q.action === "claim") {
    const i = intent as ClaimIntent,
      encoded = claimIntentToScVal(i),
      proof = request.proof ?? [];
    if (
      i.claimant !== q.actor ||
      i.resolver !== q.resolver ||
      i.context.registrar !== q.registrar ||
      i.context.network !== q.network ||
      proof.length > 64
    )
      throw new FundingError(
        "Claim route or actor differs from quote",
        "authorization",
      );
    args = [
      sponsorQuoteToScVal(q),
      encoded,
      xdr.ScVal.scvVec(proof.map((p) => sc.bytes(unhex(p)))),
    ];
    const children: NativeInvocation[] = [];
    if (i.feeAmount > 0n)
      children.push({
        contract: i.feeToken,
        method: "transfer",
        args: [
          sc.address(i.claimant),
          sc.address(i.feeRecipient),
          sc.i128(i.feeAmount),
        ],
      });
    children.push({
      contract: i.resolver,
      method: "initialize_destination",
      args: [
        claimLabelToScVal(i.label),
        sc.address(i.claimant),
        sc.u64(i.expectedGeneration === null ? 0n : i.expectedGeneration + 1n),
        paymentDestinationToScVal(i.destination),
      ],
    });
    target = {
      contract: q.registrar,
      method: "claim",
      args: [encoded],
      children,
    };
  } else {
    const i = intent as SponsoredIdentityIntent;
    if (i.actor !== q.actor || request.proof?.length)
      throw new FundingError("Identity actor or proof differs from action");
    args = [sponsorQuoteToScVal(q), sponsoredIdentityToScVal(i)];
    const reverse = q.action === "reverse";
    target =
      i.routingId === null
        ? {
            contract: reverse ? q.resolver : primary,
            method: reverse ? "set_reverse" : "set_primary",
            args: [
              sc.address(i.actor),
              nativeToScVal(i.name, { type: "string" }),
            ],
          }
        : {
            contract: lookup,
            method: reverse ? "set_reverse_muxed" : "set_primary_muxed",
            args: [
              sc.address(i.actor),
              sc.u64(i.routingId),
              nativeToScVal(i.name, { type: "string" }),
            ],
          };
  }
  const plan: SponsorPlan = {
    request,
    method,
    args,
    actorInvocation: { contract: q.funding, method, args, children: [target] },
    relayerInvocation: { contract: q.funding, method, args },
    maxNetworkFee,
  };
  if (eligibilityAccount) {
    if (
      q.action !== "claim" ||
      eligibilityAccount === q.actor ||
      eligibilityAccount === q.relayer
    )
      throw new FundingError(
        "Eligibility account must be separate from user and relayer",
      );
    plan.eligibility = {
      account: address(eligibilityAccount, "account", "eligibility"),
      invocation: {
        contract: q.registrar,
        method: "claim",
        args: [claimIntentToScVal(intent as ClaimIntent)],
      },
      latestLedger: q.issuedLedger,
      maxExpirationLedger: q.expiresLedger,
    };
  }
  return plan;
}
function same(a: xdr.SorobanAuthorizedInvocation, b: NativeInvocation) {
  return a.toXDR("base64") === authorizedInvocation(b).toXDR("base64");
}
export function validateSponsorTransaction(
  tx: Transaction,
  p: SponsorPlan,
  latestLedger: number,
  signed = false,
): xdr.SorobanAuthorizationEntry {
  const q = p.request.quote;
  if (
    tx.source !== q.relayer ||
    tx.operations.length !== 1 ||
    tx.memo.type !== "none" ||
    BigInt(tx.fee) > p.maxNetworkFee ||
    tx.signatures.length ||
    latestLedger < q.issuedLedger ||
    latestLedger >= q.expiresLedger
  )
    throw new FundingError(
      "Unapproved source, operation, fee, signature or ledger",
      "authorization",
    );
  const op = tx.operations[0];
  if (
    op.type !== "invokeHostFunction" ||
    (op.source && op.source !== q.relayer) ||
    op.func.type !== "hostFunctionTypeInvokeContract"
  )
    throw new FundingError("Unexpected sponsored operation");
  const c = op.func.invokeContract;
  if (
    Address.fromScAddress(c.contractAddress).toString() !== q.funding ||
    c.functionName.toString() !== p.method ||
    c.args.length !== p.args.length ||
    c.args.some((v, n) => v.toXDR("base64") !== p.args[n].toXDR("base64"))
  )
    throw new FundingError(
      "Transaction differs from approved request",
      "authorization",
    );
  const auth = op.auth ?? [];
  if (auth.length !== (p.eligibility ? 3 : 2))
    throw new FundingError(
      "Unexpected sponsor authorization count",
      "authorization",
    );
  const sources = auth.filter(
    (e) => e.credentials.type === "sorobanCredentialsSourceAccount",
  );
  if (
    sources.length !== 1 ||
    !same(sources[0].rootInvocation, p.relayerInvocation)
  )
    throw new FundingError(
      "Relayer authorization exceeds its approved role",
      "authorization",
    );
  const actors = auth.filter(
    (e) =>
      e.credentials.type === "sorobanCredentialsAddress" &&
      Address.fromScAddress(e.credentials.address.address).toString() ===
        q.actor,
  );
  if (actors.length !== 1 || !same(actors[0].rootInvocation, p.actorInvocation))
    throw new FundingError(
      "User authorization differs from approved action",
      "authorization",
    );
  const credential = actors[0].credentials;
  if (credential.type !== "sorobanCredentialsAddress")
    throw new FundingError("Missing actor credential");
  if (signed) {
    if (
      credential.address.signatureExpirationLedger <= latestLedger ||
      credential.address.signatureExpirationLedger > q.expiresLedger ||
      credential.address.signature.toXDR().length > 16384 ||
      // G accounts use Stellar's native vector format. C accounts define their
      // own ScVal signature; enforced simulation must run their __check_auth.
      (q.actor.startsWith("G") &&
        (credential.address.signature.type !== "scvVec" ||
          !credential.address.signature.vec?.length))
    )
      throw new FundingError(
        "User authorization missing or expired",
        "authorization",
      );
  } else if (
    credential.address.signature.type !== "scvVoid" &&
    !(
      credential.address.signature.type === "scvVec" &&
      !credential.address.signature.vec?.length
    )
  )
    throw new FundingError("Refusing to re-sign an authorization");
  if (p.eligibility) {
    const entries = auth.filter(
      (e) =>
        e.credentials.type === "sorobanCredentialsAddress" &&
        Address.fromScAddress(e.credentials.address.address).toString() ===
          p.eligibility!.account,
    );
    if (entries.length !== 1)
      throw new FundingError("Missing eligibility authorization");
    validateEligibilityAuthorization(
      entries[0],
      { ...p.eligibility, latestLedger },
      signed,
    );
  }
  return actors[0];
}
export function replaceSponsorAuth(
  tx: Transaction,
  auth: xdr.SorobanAuthorizationEntry[],
  passphrase: string,
): Transaction {
  const op = tx.operations[0];
  if (op.type !== "invokeHostFunction")
    throw new FundingError("Unexpected operation");
  return TransactionBuilder.cloneFrom(tx, { networkPassphrase: passphrase })
    .clearOperations()
    .addOperation(Operation.invokeHostFunction({ func: op.func, auth }))
    .build();
}
export class SoranSponsorship extends FundingReader {
  async plan(
    request: SponsorRequest,
    maxNetworkFee: bigint,
  ): Promise<SponsorPlan> {
    await this.validateQuote(request.quote);
    let eligibility: string | undefined;
    if (request.quote.action === "claim") {
      const i = request.intent as ClaimIntent;
      if (i.context.registry !== this.registryId)
        throw new FundingError("Claim Registry differs from deployment");
      const r = await this.read(
        request.quote.registrar,
        "claim_quote",
        [claimLabelToScVal(i.label), sc.address(i.claimant)],
        request.quote.issuedLedger,
      );
      const admission = claimQuoteFromNative(r.value).config?.settings
        .admission;
      if (admission?.type === "approval") eligibility = admission.account;
    }
    return sponsorPlan(
      request,
      this.lookupId,
      this.primaryId,
      maxNetworkFee,
      eligibility,
    );
  }
  async prepare(request: SponsorRequest, maxNetworkFee: bigint, inclusionFee = 100n) {
    if (inclusionFee < 100n || inclusionFee > maxNetworkFee || inclusionFee > 0xffff_ffffn)
      throw new FundingError("Invalid network inclusion fee");
    const plan = await this.plan(request, maxNetworkFee);
    const raw = new TransactionBuilder(
      await this.server.getAccount(request.quote.relayer),
      { fee: inclusionFee.toString(), networkPassphrase: this.passphrase },
    )
      .addOperation(
        new Contract(this.fundingId).call(plan.method, ...plan.args),
      )
      .setTimeout(60)
      .build();
    const sim = await this.server.simulateTransaction(
      raw,
      undefined,
      undefined,
      false,
    );
    if (rpc.Api.isSimulationRestore(sim))
      throw new FundingError(
        "Separate storage restoration is required; sponsorship is unavailable",
        "unavailable",
      );
    if (!rpc.Api.isSimulationSuccess(sim) || !sim.result)
      throw new FundingError("Sponsored simulation failed", "unavailable");
    const transaction = rpc.assembleTransaction(raw, sim).build();
    validateSponsorTransaction(transaction, plan, sim.latestLedger);
    return { transaction, plan, ledger: sim.latestLedger };
  }
  /** Sign only the caller's G authorization. Wallet adapters retain custody of keys. */
  async authorize(
    request: SponsorRequest,
    encoded: string,
    signer: Parameters<typeof authorizeEntry>[1],
    maxSponsorCharge: bigint,
    maxNetworkFee: bigint,
    eligibilityXdr?: string,
  ) {
    if (request.quote.charge > maxSponsorCharge)
      throw new FundingError("Sponsor charge exceeds the reviewed amount");
    address(request.quote.actor, "account", "this adapter's signing wallet");
    const plan = await this.plan(request, maxNetworkFee),
      parsed = TransactionBuilder.fromXDR(encoded, this.passphrase);
    if (!(parsed instanceof Transaction))
      throw new FundingError(
        "Fee-bump envelopes are not supported by this transport",
      );
    const latest = await this.server.getLatestLedger();
    const entry = validateSponsorTransaction(parsed, plan, latest.sequence);
    const signed = await authorizeEntry(
      entry,
      signer,
      request.quote.expiresLedger,
      this.passphrase,
    );
    const op = parsed.operations[0];
    if (op.type !== "invokeHostFunction")
      throw new FundingError("Unexpected operation");
    const auth = (op.auth ?? []).map((e) =>
      e.credentials.type === "sorobanCredentialsAddress" &&
      Address.fromScAddress(e.credentials.address.address).toString() ===
        request.quote.actor
        ? signed
        : e,
    );
    if (plan.eligibility) {
      if (!eligibilityXdr || eligibilityXdr.length > 32768)
        throw new FundingError(
          "This claim requires the app's eligibility authorization",
        );
      const approval = xdr.SorobanAuthorizationEntry.fromXDR(
        eligibilityXdr,
        "base64",
      );
      validateEligibilityAuthorization(approval, {
        ...plan.eligibility,
        latestLedger: latest.sequence,
      });
      const at = auth.findIndex(
        (e) =>
          e.credentials.type === "sorobanCredentialsAddress" &&
          Address.fromScAddress(e.credentials.address.address).toString() ===
            plan.eligibility!.account,
      );
      auth[at] = approval;
    }
    const tx = replaceSponsorAuth(parsed, auth, this.passphrase);
    validateSponsorTransaction(tx, plan, latest.sequence, true);
    return tx.toXDR();
  }
}
