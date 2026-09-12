import { hash, nativeToScVal, scValToNative, xdr } from "@stellar/stellar-sdk";
import {
  address,
  amount,
  bool,
  bytes32,
  exactObject,
  hex,
  hex32,
  label,
  paymentDestinationToScVal,
  sc,
  struct,
  u32,
  u64,
  unhex,
} from "./native-codec.js";
import { destinationFromNative, type PaymentDestination } from "./payment.js";
import { claimIntentToScVal, type ClaimIntent } from "./native-types.js";

export class FundingError extends Error {
  constructor(
    message: string,
    readonly kind:
      | "invalid"
      | "unavailable"
      | "authorization"
      | "pending"
      | "failed" = "invalid",
    readonly transactionHash: string | null = null,
  ) {
    super(message);
    this.name = "FundingError";
  }
}
export type SponsoredAction = "claim" | "reverse" | "primary";
export type FundingConfiguration = {
  registry: string;
  nativeAsset: string;
  lookup: string;
  primary: string;
  governance: string;
  paused: boolean;
  revision: bigint;
};
export type FundingPosition = {
  namespace: string;
  ownerEpoch: bigint;
  controller: string;
  balance: bigint;
  spentTotal: bigint;
  utcDay: bigint;
  spentToday: bigint;
  policyRevision: bigint;
  status: "paused" | "active" | "closed";
};
export type SponsorPolicy = {
  claimCap: bigint;
  reverseCap: bigint;
  primaryCap: bigint;
  dailyCap: bigint;
  totalCap: bigint;
  claimsPerWallet: bigint;
  identityPerDay: number;
  relayer: string;
  quoteLifetime: number;
  validUntil: bigint;
};
export type SponsorQuote = {
  network: string;
  funding: string;
  configRevision: bigint;
  fundId: string;
  policyRevision: bigint;
  action: SponsoredAction;
  actor: string;
  nonce: bigint;
  quoteId: string;
  intentHash: string;
  registrar: string;
  resolver: string;
  relayer: string;
  charge: bigint;
  issuedLedger: number;
  expiresLedger: number;
};
export type SponsoredIdentityIntent = {
  name: string;
  actor: string;
  routingId: bigint | null;
  generation: bigint;
  destination: PaymentDestination;
  previous: string | null;
};
export type SponsorReceipt = {
  quoteId: string;
  intentHash: string;
  actor: string;
  nonce: bigint;
  action: SponsoredAction;
  charge: bigint;
  relayer: string;
  balance: bigint;
  ledger: number;
};
export type SponsorActorState = {
  nonce: bigint;
  claims: bigint;
  utcDay: bigint;
  identityToday: number;
  lastReceipt: SponsorReceipt | null;
};

type Codec = { encode(v: unknown): xdr.ScVal; decode(v: unknown): unknown };
const primitive = (
  validate: (v: unknown) => any,
  encode: (v: any) => xdr.ScVal,
): Codec => ({ encode: (v) => encode(validate(v)), decode: validate });
const U64 = primitive((v) => u64(v, "funding u64"), sc.u64),
  U32 = primitive((v) => u32(v, "funding u32"), sc.u32);
const MONEY = primitive((v) => amount(v, "funding amount"), sc.i128),
  BOOL = primitive((v) => bool(v, "funding boolean"), sc.bool);
const G = primitive(
    (v) => address(v, "account", "funding account"),
    sc.address,
  ),
  C = primitive((v) => address(v, "contract", "funding contract"), sc.address),
  ID = primitive(
    (v) => address(v, "identity", "funding controller"),
    sc.address,
  );
const HEX: Codec = {
  encode: (v) => sc.bytes(unhex(hex32(v, "funding hash"))),
  decode: (v) => hex(bytes32(v, "funding hash")),
};
function fullName(v: unknown): string {
  if (typeof v !== "string") throw new FundingError("name must be a string");
  const parts = v.split(".");
  if (parts.length !== 2)
    throw new FundingError("name must include its namespace");
  parts.forEach(label);
  return v;
}
const NAME = primitive(fullName, (v) => nativeToScVal(v, { type: "string" }));
const optional = (c: Codec): Codec => ({
  encode: (v) => (v === null ? xdr.ScVal.scvVoid() : c.encode(v)),
  decode: (v) => (v === null || v === undefined ? null : c.decode(v)),
});
const enumeration = (tags: Record<string, string>): Codec => ({
  encode: (v) => {
    if (typeof v !== "string" || !Object.hasOwn(tags, v))
      throw new FundingError("unknown funding enum");
    return xdr.ScVal.scvVec([sc.symbol(tags[v])]);
  },
  decode: (v) => {
    if (!Array.isArray(v) || v.length !== 1)
      throw new FundingError("malformed funding enum");
    const pair = Object.entries(tags).find(([, tag]) => tag === v[0]);
    if (!pair) throw new FundingError("unknown funding enum");
    return pair[0];
  },
});
const ACTION = enumeration({
  claim: "Claim",
  reverse: "Reverse",
  primary: "Primary",
});
const snake = (v: string) => v.replace(/[A-Z]/g, (c) => "_" + c.toLowerCase());
function model(fields: Record<string, Codec>): Codec {
  return {
    encode: (v) => {
      const r = exactObject(v, Object.keys(fields), "funding input");
      return struct(
        Object.fromEntries(
          Object.entries(fields).map(([k, c]) => [snake(k), c.encode(r[k])]),
        ),
      );
    },
    decode: (v) => {
      const r = exactObject(
        v,
        Object.keys(fields).map(snake),
        "funding result",
      );
      return Object.fromEntries(
        Object.entries(fields).map(([k, c]) => [k, c.decode(r[snake(k)])]),
      );
    },
  };
}
const CONFIG = model({
  registry: C,
  nativeAsset: C,
  lookup: C,
  primary: C,
  governance: ID,
  paused: BOOL,
  revision: U64,
});
const POSITION = model({
  namespace: HEX,
  ownerEpoch: U64,
  controller: ID,
  balance: MONEY,
  spentTotal: MONEY,
  utcDay: U64,
  spentToday: MONEY,
  policyRevision: U64,
  status: enumeration({ paused: "Paused", active: "Active", closed: "Closed" }),
});
const POLICY = model({
  claimCap: MONEY,
  reverseCap: MONEY,
  primaryCap: MONEY,
  dailyCap: MONEY,
  totalCap: MONEY,
  claimsPerWallet: U64,
  identityPerDay: U32,
  relayer: G,
  quoteLifetime: U32,
  validUntil: U64,
});
const QUOTE = model({
  network: HEX,
  funding: C,
  configRevision: U64,
  fundId: HEX,
  policyRevision: U64,
  action: ACTION,
  actor: ID,
  nonce: U64,
  quoteId: HEX,
  intentHash: HEX,
  registrar: C,
  resolver: C,
  relayer: G,
  charge: MONEY,
  issuedLedger: U32,
  expiresLedger: U32,
});
const DEST: Codec = {
  encode: (v) => paymentDestinationToScVal(v as PaymentDestination),
  decode: destinationFromNative,
};
const IDENTITY = model({
  name: NAME,
  actor: ID,
  routingId: optional(U64),
  generation: U64,
  destination: DEST,
  previous: optional(NAME),
});
const RECEIPT = model({
  quoteId: HEX,
  intentHash: HEX,
  actor: ID,
  nonce: U64,
  action: ACTION,
  charge: MONEY,
  relayer: G,
  balance: MONEY,
  ledger: U32,
});
const LAST_RECEIPT: Codec = {
  encode: (v) =>
    xdr.ScVal.scvVec(
      v === null
        ? [sc.symbol("Empty")]
        : [sc.symbol("Recorded"), RECEIPT.encode(v)],
    ),
  decode: (v) => {
    if (Array.isArray(v) && v.length === 1 && v[0] === "Empty") return null;
    if (Array.isArray(v) && v.length === 2 && v[0] === "Recorded")
      return RECEIPT.decode(v[1]);
    throw new FundingError("malformed receipt state");
  },
};
const ACTOR = model({
  nonce: U64,
  claims: U64,
  utcDay: U64,
  identityToday: U32,
  lastReceipt: LAST_RECEIPT,
});

export const fundingConfigurationFromNative = (v: unknown) =>
  CONFIG.decode(v) as FundingConfiguration;
export const fundingPositionFromNative = (v: unknown) =>
  POSITION.decode(v) as FundingPosition;
export const sponsorPolicyFromNative = (v: unknown) =>
  POLICY.decode(v) as SponsorPolicy;
export const sponsorQuoteFromNative = (v: unknown) =>
  QUOTE.decode(v) as SponsorQuote;
export const sponsoredIdentityFromNative = (v: unknown) =>
  IDENTITY.decode(v) as SponsoredIdentityIntent;
export const sponsorReceiptFromNative = (v: unknown) =>
  RECEIPT.decode(v) as SponsorReceipt;
export const sponsorActorFromNative = (v: unknown) =>
  ACTOR.decode(v) as SponsorActorState;
export const sponsoredActionToScVal = (v: SponsoredAction) => ACTION.encode(v);
export function sponsorPolicyToScVal(v: SponsorPolicy): xdr.ScVal {
  const value = POLICY.encode(v);
  if (
    v.dailyCap === 0n ||
    v.totalCap === 0n ||
    v.dailyCap > v.totalCap ||
    [v.claimCap, v.reverseCap, v.primaryCap].some((n) => n > v.dailyCap) ||
    [v.claimCap, v.reverseCap, v.primaryCap].every((n) => n === 0n) ||
    (v.claimCap > 0n && v.claimsPerWallet === 0n) ||
    ((v.reverseCap > 0n || v.primaryCap > 0n) && v.identityPerDay === 0) ||
    v.quoteLifetime < 1 ||
    v.quoteLifetime > 120 ||
    v.validUntil === 0n
  )
    throw new FundingError(
      "invalid coverage, spending limits or policy lifetime",
    );
  return value;
}
export function sponsorQuoteToScVal(v: SponsorQuote): xdr.ScVal {
  const result = QUOTE.encode(v);
  if (
    v.charge === 0n ||
    v.actor === v.relayer ||
    v.expiresLedger <= v.issuedLedger ||
    v.expiresLedger - v.issuedLedger > 120
  )
    throw new FundingError("invalid sponsor charge, actor or quote lifetime");
  return result;
}
export const sponsoredIdentityToScVal = (v: SponsoredIdentityIntent) =>
  IDENTITY.encode(v);
export function sponsorIntentHash(
  action: SponsoredAction,
  intent: ClaimIntent | SponsoredIdentityIntent,
): string {
  const encoded =
    action === "claim"
      ? claimIntentToScVal(intent as ClaimIntent)
      : sponsoredIdentityToScVal(intent as SponsoredIdentityIntent);
  return hex(
    hash(xdr.ScVal.scvVec([sc.symbol("sponsor_" + action), encoded]).toXDR()),
  );
}
export function fundingPositionId(
  namespace: string,
  ownerEpoch: bigint,
): string {
  return hex(
    hash(
      xdr.ScVal.scvVec([
        sc.symbol("fund_v1"),
        HEX.encode(namespace),
        U64.encode(ownerEpoch),
      ]).toXDR(),
    ),
  );
}
/** Canonical XDR is used for transport; JSON bigint coercion is never accepted. */
export const encodeSponsorQuote = (v: SponsorQuote) =>
  sponsorQuoteToScVal(v).toXDR("base64");
export function decodeSponsorQuote(encoded: string): SponsorQuote {
  if (typeof encoded !== "string" || encoded.length > 16_384)
    throw new FundingError("invalid sponsor quote size");
  const q = sponsorQuoteFromNative(
    scValToNative(xdr.ScVal.fromXDR(encoded, "base64")),
  );
  sponsorQuoteToScVal(q);
  return q;
}
export const FUNDING_ERRORS: Record<number, string> = {
  1: "Not initialized",
  2: "Unsupported network",
  3: "Invalid configuration",
  4: "Funding position not found",
  5: "Funding position already exists",
  6: "Funding position closed",
  7: "Namespace ownership changed",
  8: "Contract state unavailable",
  9: "Invalid amount",
  10: "Insufficient sponsorship funds",
  11: "Invalid spending policy",
  12: "Spending policy not configured",
  13: "Sponsorship paused",
  14: "Quote is stale",
  15: "Quote expired",
  16: "Invalid quote",
  17: "Spending limit reached",
  18: "Wallet allowance reached",
  19: "Request already used",
  20: "Action is not sponsored",
  21: "Namespace contract changed",
  22: "Action differs from approval",
  23: "Action already completed",
  24: "Name operation failed",
  25: "Sponsor payment failed",
  26: "Amount or counter overflow",
  27: "Re-entry refused",
  28: "Invalid name",
  29: "Name inactive",
  30: "Name state changed",
  31: "Upgrade does not match",
};
