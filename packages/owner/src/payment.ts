/** Direct v1 and muxed v2 payment records. Kept identical in the independently published lookup
 * and holder packages; the conformance tests exercise both copies. */
import { StrKey, nativeToScVal, xdr } from "@stellar/stellar-sdk";

export const PAYMENT_RECORD_KEY = "payment";
export type PaymentMemo =
  | { type: "none" }
  | { type: "id"; value: string }
  | { type: "text"; value: string }
  | { type: "hash"; value: string };
export type PaymentDestination = { address: string; memo: PaymentMemo };
const MAX_U64 = 18446744073709551615n;
const utf8 = (value: string) => new TextEncoder().encode(value);

/** Reject invalid data without normalizing meaningful memo bytes. */
export function validatePaymentDestination(value: unknown): PaymentDestination {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid payment destination");
  const p = value as Record<string, unknown>;
  if (Object.keys(p).sort().join(",") !== "address,memo") throw new Error("unexpected payment fields");
  if (typeof p.address !== "string" || (!StrKey.isValidEd25519PublicKey(p.address) && !StrKey.isValidContract(p.address) && !StrKey.isValidMed25519PublicKey(p.address)))
    throw new Error("payment address must be a valid G, C or M address");
  if (!p.memo || typeof p.memo !== "object" || Array.isArray(p.memo)) throw new Error("invalid memo");
  const m = p.memo as Record<string, unknown>;
  if (m.type === "none") {
    if (Object.keys(m).join(",") !== "type") throw new Error("none memo cannot have a value");
    if (StrKey.isValidMed25519PublicKey(p.address)) decodeMuxedAddress(p.address);
    return { address: p.address, memo: { type: "none" } };
  }
  if (!StrKey.isValidEd25519PublicKey(p.address)) throw new Error("memos require a classic G address");
  if (Object.keys(m).sort().join(",") !== "type,value" || typeof m.value !== "string") throw new Error("memo value must be a string");
  switch (m.type) {
    case "id":
      if (!/^(0|[1-9][0-9]{0,19})$/.test(m.value) || BigInt(m.value) > MAX_U64) throw new Error("memo ID must be canonical decimal u64");
      return { address: p.address, memo: { type: "id", value: m.value } };
    case "text": {
      const bytes = utf8(m.value);
      if (!bytes.length || bytes.length > 28 || new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes) !== m.value)
        throw new Error("memo text must be valid UTF-8, 1–28 bytes");
      return { address: p.address, memo: { type: "text", value: m.value } };
    }
    case "hash":
      if (!/^[0-9a-f]{64}$/.test(m.value)) throw new Error("memo hash must be 32 bytes as lowercase hex");
      return { address: p.address, memo: { type: "hash", value: m.value } };
    default: throw new Error("unsupported memo type");
  }
}

export function encodePaymentRecord(value: PaymentDestination): string {
  const p = validatePaymentDestination(value);
  if (StrKey.isValidMed25519PublicKey(p.address)) {
    const muxed = decodeMuxedAddress(p.address);
    return `2|${muxed.account}|muxed|${muxed.id}`;
  }
  return `1|${p.address}|${p.memo.type}|${p.memo.type === "none" ? "" : p.memo.value}`;
}

/** Empty/missing records are not explicit payment instructions. */
export function parsePaymentRecord(raw: string): PaymentDestination {
  if (typeof raw !== "string" || utf8(raw).length > 128) throw new Error("invalid payment record length");
  const first = raw.indexOf("|");
  const second = raw.indexOf("|", first + 1);
  const third = raw.indexOf("|", second + 1);
  if (first < 0 || second < 0 || third < 0) throw new Error("unsupported payment record");
  const version = raw.slice(0, first);
  const address = raw.slice(first + 1, second);
  const type = raw.slice(second + 1, third);
  const value = raw.slice(third + 1);
  if (version === "2" && type === "muxed")
    return { address: encodeMuxedAddress(address, value), memo: { type: "none" } };
  if (version !== "1" || (!StrKey.isValidEd25519PublicKey(address) && !StrKey.isValidContract(address)))
    throw new Error("unsupported payment record");
  if (type === "none" && value !== "") throw new Error("none memo cannot have a value");
  return validatePaymentDestination({ address, memo: type === "none" ? { type } : { type, value } });
}

export function paymentMemoToScVal(memo: PaymentMemo): xdr.ScVal {
  const symbol = (s: string) => nativeToScVal(s, { type: "symbol" });
  switch (memo.type) {
    case "none": return xdr.ScVal.scvVec([symbol("None")]);
    case "id": return xdr.ScVal.scvVec([symbol("Id"), nativeToScVal(BigInt(memo.value), { type: "u64" })]);
    case "text": return xdr.ScVal.scvVec([symbol("Text"), nativeToScVal(memo.value, { type: "string" })]);
    case "hash": return xdr.ScVal.scvVec([symbol("Hash"), nativeToScVal(Uint8Array.from(memo.value.match(/../g)!, (b) => parseInt(b, 16)), { type: "bytes" })]);
  }
}

/** Decode Soroban contract enum values, checking arity and native types. */
export function paymentFromNative(raw: unknown): PaymentDestination {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("invalid payment result");
  const p = raw as Record<string, unknown>;
  if (Object.keys(p).sort().join(",") !== "address,memo" || !Array.isArray(p.memo)) throw new Error("invalid payment result fields");
  if (typeof p.address !== "string" || (!StrKey.isValidEd25519PublicKey(p.address) && !StrKey.isValidContract(p.address)))
    throw new Error("direct payment must contain a G or C address");
  const m = p.memo;
  let memo: PaymentMemo;
  if (m.length === 1 && m[0] === "None") memo = { type: "none" };
  else if (m.length === 2 && m[0] === "Id" && typeof m[1] === "bigint") memo = { type: "id", value: m[1].toString() };
  else if (m.length === 2 && m[0] === "Text" && typeof m[1] === "string") memo = { type: "text", value: m[1] };
  else if (m.length === 2 && m[0] === "Hash" && m[1] instanceof Uint8Array && m[1].length === 32)
    memo = { type: "hash", value: Array.from(m[1], (b) => b.toString(16).padStart(2, "0")).join("") };
  else throw new Error("invalid payment memo result");
  return validatePaymentDestination({ address: p.address, memo });
}

/** Decode a full muxed destination without treating its operation ID as a memo. */
export function decodeMuxedAddress(address: string): { account: string; id: string } {
  if (typeof address !== "string" || !StrKey.isValidMed25519PublicKey(address)) throw new Error("invalid muxed M address");
  const raw = StrKey.decodeMed25519PublicKey(address);
  if (raw.length !== 40 || StrKey.encodeMed25519PublicKey(raw) !== address) throw new Error("noncanonical muxed address");
  let id = 0n;
  for (const byte of raw.subarray(32)) id = (id << 8n) | BigInt(byte);
  return { account: StrKey.encodeEd25519PublicKey(raw.subarray(0, 32)), id: id.toString() };
}

/** Encode only canonical G + exact decimal u64; numbers are never accepted. */
export function encodeMuxedAddress(account: string, id: string): string {
  if (typeof account !== "string" || !StrKey.isValidEd25519PublicKey(account)) throw new Error("muxed base must be a G account");
  if (typeof id !== "string" || !/^(0|[1-9][0-9]{0,19})$/.test(id) || BigInt(id) > MAX_U64) throw new Error("muxed ID must be canonical decimal u64");
  const raw = new Uint8Array(40);
  raw.set(StrKey.decodeEd25519PublicKey(account));
  let value = BigInt(id);
  for (let i = 39; i >= 32; i--) { raw[i] = Number(value & 255n); value >>= 8n; }
  return StrKey.encodeMed25519PublicKey(raw);
}

/** Strict additive on-chain destination enum; v1 payment structs stay separate. */
export function destinationFromNative(raw: unknown): PaymentDestination {
  if (!Array.isArray(raw) || raw.length !== 2) throw new Error("invalid destination enum");
  if (raw[0] === "Direct") return paymentFromNative(raw[1]);
  if (raw[0] !== "Muxed" || !raw[1] || typeof raw[1] !== "object" || Array.isArray(raw[1])) throw new Error("invalid destination variant");
  const value = raw[1] as Record<string, unknown>;
  if (Object.keys(value).sort().join(",") !== "account,id" || typeof value.account !== "string" || typeof value.id !== "bigint")
    throw new Error("invalid muxed destination fields");
  return { address: encodeMuxedAddress(value.account, value.id.toString()), memo: { type: "none" } };
}
