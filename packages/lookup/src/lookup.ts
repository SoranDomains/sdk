import { StrKey } from "@stellar/stellar-sdk";
import { paymentFromNative, type PaymentDestination } from "./payment.js";

type LookupContext = {
  /** Canonical name submitted to the contract. */
  name: string;
  /** Registry-selected Registrar for this name's namespace. */
  registrar: string;
  /** Exact ownership generation; never convert to a JavaScript number. */
  generation: bigint;
};

/** A complete native payment instruction, including an explicit memo type. */
export type NativePaymentResolution = LookupContext & {
  kind: "nativePayment";
  resolver: string;
  payment: PaymentDestination;
};

/** An address from a legacy implementation cannot establish memo safety. */
export type LegacyAddressResolution = LookupContext & {
  kind: "legacyAddress";
  resolver: string | null;
  address: string;
  memoCapability: "unknown";
};

export type LookupResult = NativePaymentResolution | LegacyAddressResolution;

/** Decode the universal Lookup v1 ABI without coercing or discarding fields. */
export function lookupFromNative(raw: unknown, expectedName: string): LookupResult {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("invalid lookup result");
  const r = raw as Record<string, unknown>;
  if (Object.keys(r).sort().join(",") !== "generation,name,registrar,resolver,result")
    throw new Error("unexpected lookup result fields");
  if (r.name !== expectedName) throw new Error("lookup name does not match the requested canonical name");
  if (typeof r.registrar !== "string" || !StrKey.isValidContract(r.registrar))
    throw new Error("lookup Registrar must be a valid C address");
  if (r.resolver !== null && (typeof r.resolver !== "string" || !StrKey.isValidContract(r.resolver)))
    throw new Error("lookup Resolver must be a valid C address or null");
  if (typeof r.generation !== "bigint" || r.generation < 0n || r.generation > 18446744073709551615n)
    throw new Error("lookup generation must be an exact u64 bigint");
  if (!Array.isArray(r.result) || r.result.length !== 2) throw new Error("invalid lookup result enum");
  const context = { name: expectedName, registrar: r.registrar, generation: r.generation };
  if (r.result[0] === "NativePayment") {
    if (r.resolver === null) throw new Error("native payment requires a Resolver");
    return { ...context, kind: "nativePayment", resolver: r.resolver, payment: paymentFromNative(r.result[1]) };
  }
  if (r.result[0] === "LegacyAddress") {
    const address: unknown = r.result[1];
    if (typeof address !== "string" || (!StrKey.isValidEd25519PublicKey(address) && !StrKey.isValidContract(address)))
      throw new Error("legacy address must be a valid G or C address");
    return { ...context, kind: "legacyAddress", resolver: r.resolver, address, memoCapability: "unknown" };
  }
  throw new Error("unsupported lookup result enum");
}
