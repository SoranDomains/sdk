import {
  TestnetSponsorHistory,
  sponsorRpcReceipt,
  type SponsorHistory,
} from "./funding-history.js";
import { claimIntentToScVal, type ClaimIntent } from "./native-types.js";
import {
  FundingError,
  decodeSponsorQuote,
  readBoundedText,
  sponsoredIdentityToScVal,
  sponsorIntentHash,
  sponsorQuoteToScVal,
  type SponsorQuote,
  type SponsoredAction,
  type SponsoredIdentityIntent,
} from "./funding-types.js";
import { SoranSponsorship, type SponsorRequest } from "./funding-user.js";
/** An offer carries at most a 100000 character transaction plus the quote XDR; nothing legitimate approaches this. */
const MAX_SERVICE_BODY_BYTES = 262_144;
/** HTTP transports offers and status. The contract/RPC checks still authorize spending. */
export class FundingServiceClient {
  private base: string;
  constructor(
    baseUrl: string,
    private client: SoranSponsorship,
    private request: typeof fetch = (input, init) =>
      globalThis.fetch(input, init),
    private history: SponsorHistory = new TestnetSponsorHistory(),
  ) {
    const url = new URL(baseUrl);
    if (
      url.username ||
      url.password ||
      url.hash ||
      url.search ||
      (url.protocol !== "https:" &&
        !(
          url.protocol === "http:" &&
          ["localhost", "127.0.0.1"].includes(url.hostname)
        ))
    )
      throw new FundingError(
        "Sponsorship API must use HTTPS or a local development endpoint",
      );
    this.base = url.toString().replace(/\/$/, "");
  }
  private async call(path: string, body?: unknown): Promise<any> {
    let r: Response;
    try {
      r = await this.request(this.base + path, {
        method: body === undefined ? "GET" : "POST",
        headers:
          body === undefined
            ? undefined
            : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(30000),
        redirect: "error",
      });
    } catch {
      throw new FundingError(
        "Service response unavailable. Keep your quote reference and recover its status before submitting again.",
        "unavailable",
      );
    }
    let value: Record<string, unknown>;
    let text: string | null;
    try {
      text = await readBoundedText(r, MAX_SERVICE_BODY_BYTES);
    } catch {
      text = "";
    }
    // Too large is handled like an unreadable body: a submit's outcome is unknown.
    if (text === null)
      throw new FundingError(
        "Service response was too large. Keep your quote reference and recover its status before submitting again.",
        path === "/v1/sponsorship/submit" ? "pending" : "unavailable",
      );
    try {
      value = JSON.parse(text) as Record<string, unknown>;
    } catch {
      // A proxy/gateway error page (e.g. a 502 HTML body) is not JSON. A
      // submit's outcome is then unknown, so it reads as pending; anything
      // else simply could not be answered.
      throw new FundingError(
        "Service response was not valid JSON. Keep your quote reference and recover its status before submitting again.",
        path === "/v1/sponsorship/submit" ? "pending" : "unavailable",
      );
    }
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new FundingError("Invalid service response", "unavailable");
    if (!r.ok || value.error)
      throw new FundingError(
        typeof value.detail === "string"
          ? value.detail
          : "Sponsorship request stopped",
        value.error === "pending" ? "pending" : "unavailable",
        typeof value.transactionHash === "string"
          ? value.transactionHash
          : null,
      );
    return value;
  }
  async quote(
    action: SponsoredAction,
    intent: ClaimIntent | SponsoredIdentityIntent,
    maxSponsorCharge: bigint,
    proof: readonly string[] = [],
  ) {
    const encoded =
      action === "claim"
        ? claimIntentToScVal(intent as ClaimIntent)
        : sponsoredIdentityToScVal(intent as SponsoredIdentityIntent);
    const offer = await this.call("/v1/sponsorship/quote", {
      action,
      intentXdr: encoded.toXDR("base64"),
      proof,
    });
    return this.reviewOffer(offer, action, intent, maxSponsorCharge, proof);
  }
  /** Re-estimate with the previous, valid wallet authorization. This never
   * submits; review the new charge and call authorize again before submit. */
  async refreshQuote(request: SponsorRequest, authorizedTransactionXdr: string, maxSponsorCharge: bigint) {
    this.id(request.quote.quoteId);
    const offer = await this.call("/v1/sponsorship/requote", {
      quoteId: request.quote.quoteId, transactionXdr: authorizedTransactionXdr,
    });
    return this.reviewOffer(offer, request.quote.action, request.intent, maxSponsorCharge, request.proof ?? []);
  }
  private async reviewOffer(offer: any, action: SponsoredAction, intent: ClaimIntent | SponsoredIdentityIntent, maxSponsorCharge: bigint, proof: readonly string[]) {
    const quote = decodeSponsorQuote(offer.quoteXdr);
    if (
      offer.id !== quote.quoteId ||
      quote.action !== action ||
      quote.intentHash !== sponsorIntentHash(action, intent) ||
      quote.charge > maxSponsorCharge ||
      typeof offer.transactionXdr !== "string" ||
      offer.transactionXdr.length > 100000
    )
      throw new FundingError(
        "Sponsorship offer differs from the action or charge you reviewed",
        "authorization",
      );
    await this.client.validateQuote(quote);
    return {
      request: { quote, intent, proof } satisfies SponsorRequest,
      transactionXdr: offer.transactionXdr,
    };
  }
  async submit(quote: SponsorQuote, authorizedTransactionXdr: string) {
    this.id(quote.quoteId);
    const result = await this.call("/v1/sponsorship/submit", {
      quoteId: quote.quoteId,
      transactionXdr: authorizedTransactionXdr,
    });
    return this.result(quote, result);
  }
  async status(quote: SponsorQuote) {
    this.id(quote.quoteId);
    return this.result(
      quote,
      await this.call(`/v1/sponsorship/status/${quote.quoteId}`),
    );
  }
  private id(id: string) {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new FundingError("Invalid quote ID");
  }
  private async result(
    quote: SponsorQuote,
    value: any,
  ): Promise<{
    id: string;
    status:
      | "quoted"
      | "dispatching"
      | "pending"
      | "unknown"
      | "success"
      | "failed"
      | "expired";
    transactionHash: string | null;
  }> {
    if (
      value.id !== quote.quoteId ||
      quote.funding !== this.client.fundingId ||
      quote.network !== this.client.networkId ||
      ![
        "quoted",
        "dispatching",
        "pending",
        "unknown",
        "success",
        "failed",
        "expired",
      ].includes(value.status) ||
      (value.transactionHash !== null &&
        !/^[a-f0-9]{64}$/.test(value.transactionHash))
    )
      throw new FundingError(
        "Unverifiable sponsorship status; preserve the original quote reference",
        "unavailable",
      );
    if (value.status === "success" || value.status === "failed") {
      if (!value.transactionHash)
        throw new FundingError(
          "Missing confirmed transaction hash",
          "unavailable",
        );
      const result = await this.client.server.getTransaction(
        value.transactionHash,
      );
      const receipt =
        result.status === "SUCCESS" || result.status === "FAILED"
          ? sponsorRpcReceipt(
              result,
              quote,
              value.transactionHash,
              this.client.passphrase,
            )
          : await this.history.find(
              value.transactionHash,
              quote,
              (await this.client.server.getLatestLedger()).sequence,
              this.client.passphrase,
            );
      // Fetch independently from a trusted chain provider. API receipt bytes or
      // a persisted status alone cannot establish canonical inclusion.
      if (!receipt || receipt.status !== value.status)
        throw new FundingError(
          "Service outcome is not confirmed by chain history",
          "pending",
          value.transactionHash,
        );
    }
    return value;
  }
}
