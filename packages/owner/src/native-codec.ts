/** Local successor-ABI helpers. No deployed defaults are changed by this module. */
import { Address, StrKey, hash, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { decodeMuxedAddress, paymentMemoToScVal, validatePaymentDestination, type PaymentDestination } from "./payment.js";

export const NATIVE_REGISTRAR_ERRORS: Record<number,string> = {21:"InvalidClaimConfig",22:"ClaimsNotConfigured",23:"ClaimsPaused",24:"StaleClaimPolicy",25:"ClaimIntentMismatch",26:"ClaimIntentExpired",27:"ReservedName",28:"NameNotReserved",29:"PublicIssuanceRequired",30:"WalletClaimLimit",31:"InvalidEligibility",32:"ApprovalAllowanceReached",33:"ApprovalRateReached",34:"RequestIdConflict",35:"CounterOverflow",36:"InvalidNativeBinding",37:"UnsupportedClaimant",38:"DuplicateLabel",39:"RenewalTooEarly",40:"RenewalLeaseLimit",41:"DestinationInitializationFailed",42:"FeeSettlementFailed"};
export class NativeClaimError extends Error {
  readonly contractCode: number | null;
  readonly contractError: string | null;
  constructor(message: string, readonly kind: "unsupported" | "unavailable" | "invalid" | "authorization" | "pending" | "failed" = "invalid", readonly txHash: string | null = null) {
    super(message); this.name = "NativeClaimError";
    const match=/Error\(Contract, #(\d+)\)/.exec(message);this.contractCode=match?Number(match[1]):null;this.contractError=this.contractCode===null?null:NATIVE_REGISTRAR_ERRORS[this.contractCode]??null;
  }
}

export function exactObject(raw: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).sort().join(",") !== [...keys].sort().join(","))
    throw new NativeClaimError(`invalid ${label} fields`);
  return raw as Record<string, unknown>;
}
export function u64(value: unknown, label: string): bigint {
  if (typeof value !== "bigint" || value < 0n || value > 18446744073709551615n) throw new NativeClaimError(`${label} must be an unsigned 64-bit bigint`);
  return value;
}
export function u32(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > 4294967295) throw new NativeClaimError(`${label} must be an unsigned 32-bit number`);
  return value;
}
export function amount(value: unknown, label: string): bigint {
  if (typeof value !== "bigint" || value < 0n || value > (1n << 127n) - 1n) throw new NativeClaimError(`${label} must be a nonnegative i128 bigint`);
  return value;
}
export function bool(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new NativeClaimError(`${label} must be boolean`);
  return value;
}
export function address(value: unknown, kind: "account" | "contract" | "identity", label: string): string {
  if (typeof value !== "string" || !(kind !== "contract" && StrKey.isValidEd25519PublicKey(value) || kind !== "account" && StrKey.isValidContract(value)))
    throw new NativeClaimError(`${label} must be a valid ${kind === "identity" ? "G or C" : kind === "account" ? "G" : "C"} address`);
  return value;
}
export function bytes32(value: unknown, label: string): Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== 32) throw new NativeClaimError(`${label} must contain exactly 32 bytes`);
  return new Uint8Array(value);
}
export function hex32(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) throw new NativeClaimError(`${label} must be 64 lowercase hex characters`);
  return value;
}
export const hex = (value: Uint8Array): string => Array.from(value, byte => byte.toString(16).padStart(2, "0")).join("");
export const unhex = (value: string): Uint8Array => Uint8Array.from(hex32(value, "32-byte value").match(/../g)!, byte => parseInt(byte, 16));
export const utf8 = (value: string): Uint8Array => new TextEncoder().encode(value);
export function label(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value)) throw new NativeClaimError("intent label must be canonical lowercase ASCII, 1–63 characters");
  return value;
}
export function namespaceNode(namespace: string): Uint8Array {
  const combined = new Uint8Array(64); combined.set(hash(utf8(label(namespace))), 32); return new Uint8Array(hash(combined));
}
export const sc = {
  address: (value: string) => new Address(value).toScVal(),
  bytes: (value: Uint8Array) => nativeToScVal(value, { type: "bytes" }),
  u64: (value: bigint) => nativeToScVal(value, { type: "u64" }),
  u32: (value: number) => nativeToScVal(value, { type: "u32" }),
  i128: (value: bigint) => nativeToScVal(value, { type: "i128" }),
  bool: (value: boolean) => nativeToScVal(value, { type: "bool" }),
  symbol: (value: string) => nativeToScVal(value, { type: "symbol" }),
  option: (value: xdr.ScVal | null) => value ?? xdr.ScVal.scvVoid(),
};
/** Contract structs are canonical symbol-keyed maps, not generic JSON maps. */
export function struct(fields: Record<string, xdr.ScVal>): xdr.ScVal {
  return xdr.ScVal.scvMap(Object.keys(fields).sort().map(key => new xdr.ScMapEntry({ key: sc.symbol(key), val: fields[key] })));
}
export function paymentDestinationToScVal(raw: PaymentDestination): xdr.ScVal {
  const payment = validatePaymentDestination(raw);
  if (StrKey.isValidMed25519PublicKey(payment.address)) {
    const value = decodeMuxedAddress(payment.address);
    return xdr.ScVal.scvVec([sc.symbol("Muxed"), struct({ account: sc.address(value.account), id: sc.u64(BigInt(value.id)) })]);
  }
  return xdr.ScVal.scvVec([sc.symbol("Direct"), struct({ address: sc.address(payment.address), memo: paymentMemoToScVal(payment.memo) })]);
}
export function sameScVal(left: xdr.ScVal, right: xdr.ScVal): boolean { return left.toXDR("base64") === right.toXDR("base64"); }
