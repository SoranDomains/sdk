import {
  Address,
  FeeBumpTransaction,
  Networks,
  Transaction,
  TransactionBuilder,
  rpc,
  xdr,
  hash,
} from "@stellar/stellar-sdk";
import { hex } from "./native-codec.js";
import {
  FundingError,
  sponsorQuoteToScVal,
  type SponsorQuote,
} from "./funding-types.js";

/** Receipt evidence is retained for audit; its bytes alone are not a chain-inclusion proof. */
export type FundingReceipt = {
  transactionHash: string;
  envelopeHash: string;
  envelopeXdr: string;
  resultXdr: string;
  ledger: number;
  observedLedger: number;
  status: "success" | "failed";
  provider: "stellar-rpc" | "sdf-testnet-horizon";
};
export interface SponsorHistory {
  find(
    hash: string,
    quote: SponsorQuote,
    latestLedger: number,
    passphrase: string,
  ): Promise<FundingReceipt | null>;
}

/** Input must come from the caller's trusted chain provider, never a pasted/API receipt. */
export function verifySponsorHistory(
  value: unknown,
  quote: SponsorQuote,
  expectedHash: string,
  latestLedger: number,
  passphrase: string,
  provider: FundingReceipt["provider"] = "sdf-testnet-horizon",
): FundingReceipt | null {
  const r = value as Record<string, unknown> | null;
  if (
    passphrase !== Networks.TESTNET ||
    quote.network !== hex(hash(new TextEncoder().encode(passphrase))) ||
    !/^[a-f0-9]{64}$/.test(expectedHash) ||
    !Number.isInteger(latestLedger) ||
    latestLedger < 1 ||
    latestLedger > 0xffff_ffff ||
    !r ||
    typeof r !== "object" ||
    typeof r.hash !== "string" ||
    !Number.isInteger(r.ledger) ||
    (r.ledger as number) < quote.issuedLedger ||
    (r.ledger as number) > latestLedger ||
    typeof r.successful !== "boolean" ||
    typeof r.envelope_xdr !== "string" ||
    r.envelope_xdr.length > 200000 ||
    typeof r.result_xdr !== "string" ||
    r.result_xdr.length > 200000
  )
    return null;
  try {
    const envelope = TransactionBuilder.fromXDR(r.envelope_xdr, passphrase);
    const tx =
      envelope instanceof FeeBumpTransaction
        ? envelope.innerTransaction
        : envelope;
    if (
      !(tx instanceof Transaction) ||
      hex(envelope.hash()) !== r.hash ||
      hex(tx.hash()) !== expectedHash
    )
      return null;
    const op = tx.operations[0];
    if (
      tx.source !== quote.relayer ||
      tx.operations.length !== 1 ||
      op.type !== "invokeHostFunction" ||
      (op.source && op.source !== quote.relayer) ||
      op.func.type !== "hostFunctionTypeInvokeContract" ||
      Address.fromScAddress(
        op.func.invokeContract.contractAddress,
      ).toString() !== quote.funding ||
      op.func.invokeContract.functionName.toString() !==
        "sponsor_" + quote.action ||
      op.func.invokeContract.args[0]?.toXDR("base64") !==
        sponsorQuoteToScVal(quote).toXDR("base64")
    )
      return null;
    const result = xdr.TransactionResult.fromXDR(r.result_xdr, "base64").result;
    let outcome: string;
    if (envelope instanceof FeeBumpTransaction) {
      if (
        result.type !== "txFeeBumpInnerSuccess" &&
        result.type !== "txFeeBumpInnerFailed"
      )
        return null;
      if (hex(result.innerResultPair.transactionHash.value) !== expectedHash)
        return null;
      outcome = result.innerResultPair.result.result.type;
      if (
        (result.type === "txFeeBumpInnerSuccess") !==
        (outcome === "txSuccess")
      )
        return null;
    } else outcome = result.type;
    if (
      !["txSuccess", "txFailed"].includes(outcome) ||
      r.successful !== (outcome === "txSuccess")
    )
      return null;
    return {
      transactionHash: expectedHash,
      envelopeHash: r.hash,
      envelopeXdr: r.envelope_xdr,
      resultXdr: r.result_xdr,
      ledger: r.ledger as number,
      observedLedger: latestLedger,
      status: r.successful ? "success" : "failed",
      provider,
    };
  } catch {
    return null;
  }
}

export function sponsorRpcReceipt(
  result:
    | rpc.Api.GetSuccessfulTransactionResponse
    | rpc.Api.GetFailedTransactionResponse,
  quote: SponsorQuote,
  hash: string,
  passphrase: string,
): FundingReceipt {
  try {
    const envelope = TransactionBuilder.fromXDR(result.envelopeXdr, passphrase);
    if (![hash, hex(envelope.hash())].includes(result.txHash)) throw Error();
    const receipt = verifySponsorHistory(
      {
        hash: hex(envelope.hash()),
        ledger: result.ledger,
        successful: result.status === "SUCCESS",
        envelope_xdr: envelope.toXDR(),
        result_xdr: result.resultXdr.toXDR("base64"),
      },
      quote,
      hash,
      result.latestLedger,
      passphrase,
      "stellar-rpc",
    );
    if (receipt) return receipt;
  } catch {
    /* malformed or unrelated terminal data stays uncertain */
  }
  throw new FundingError(
    "Receipt does not prove the reviewed sponsorship transaction",
    "pending",
    hash,
  );
}

/** The fixed provider is trusted for canonical inclusion, just as Stellar RPC is. */
export class TestnetSponsorHistory implements SponsorHistory {
  constructor(
    private request: typeof fetch = (input, init) =>
      globalThis.fetch(input, init),
  ) {}
  async find(
    hash: string,
    quote: SponsorQuote,
    latestLedger: number,
    passphrase: string,
  ) {
    if (passphrase !== Networks.TESTNET || !/^[a-f0-9]{64}$/.test(hash))
      throw new FundingError(
        "Invalid sponsorship history request",
        "unavailable",
      );
    const options = {
      credentials: "omit" as const,
      redirect: "error" as const,
      cache: "no-store" as const,
      signal: AbortSignal.timeout(10000),
    };
    const response = await this.request(
      `https://horizon-testnet.stellar.org/transactions/${hash}`,
      options,
    );
    if (response.status === 404) return null;
    if (!response.ok)
      throw new FundingError(
        "Sponsorship history unavailable; preserve the quote reference",
        "unavailable",
      );
    const body = await response.text();
    if (body.length > 600000)
      throw new FundingError(
        "Sponsorship history response is too large",
        "unavailable",
      );
    return verifySponsorHistory(
      JSON.parse(body),
      quote,
      hash,
      latestLedger,
      passphrase,
    );
  }
}
