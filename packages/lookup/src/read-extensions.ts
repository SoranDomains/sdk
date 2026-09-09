import { nativeToScVal, StrKey, xdr } from "@stellar/stellar-sdk";
import { decodeMuxedAddress } from "./payment.js";
import { address, u64 } from "./views.js";

export const MAX_BATCH_READS = 2;
export type RegisteredName = { registrar: string; node: string; holder: string; generation: bigint; expiresAt: bigint };
export type NameState =
  | { kind: "namespaceMissing" | "registrarMissing" | "unregistered" }
  | { kind: "active" | "expired"; record: RegisteredName };
export type NameStatus = { name: string; ledger: number; timestamp: bigint; state: NameState };
export type IdentityName =
  | { address: string; kind: "name"; name: string }
  | { address: string; kind: "none" }
  | { address: string; kind: "error"; errorCode: number; errorName: string | null };
export type BatchNames = { ledger: number; timestamp: bigint; results: IdentityName[] };
export type ObservedIdentityName = IdentityName & { ledger: number; timestamp: bigint };
export const MAX_HISTORY_IDENTITIES = 256;

function object(raw: unknown, fields: string[]): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).sort().join() !== [...fields].sort().join()) throw new Error("unexpected result fields");
  return raw as Record<string, unknown>;
}
function u32(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0 || raw > 4294967295) throw new Error("invalid u32");
  return raw;
}
function variant(raw: unknown): unknown[] {
  if (!Array.isArray(raw) || typeof raw[0] !== "string") throw new Error("invalid result variant");
  return raw;
}

export function nameStatusFromNative(raw: unknown, expectedName: string, expectedNode: string): NameStatus {
  const r = object(raw, ["name", "ledger", "timestamp", "state"]);
  if (r.name !== expectedName) throw new Error("status name mismatch");
  const ledger = u32(r.ledger), timestamp = u64(r.timestamp), v = variant(r.state);
  let state: NameState;
  const missing = { NamespaceMissing: "namespaceMissing", RegistrarMissing: "registrarMissing", Unregistered: "unregistered" } as const;
  if (Object.hasOwn(missing, v[0] as string) && v.length === 1) {
    state = { kind: missing[v[0] as keyof typeof missing] };
  } else if ((v[0] === "Active" || v[0] === "Expired") && v.length === 2) {
    const record = object(v[1], ["registrar", "node", "holder", "generation", "expires_at"]);
    if (!(record.node instanceof Uint8Array) || record.node.length !== 32) throw new Error("invalid status node");
    const node = Array.from(record.node, byte => byte.toString(16).padStart(2, "0")).join("");
    if (node !== expectedNode) throw new Error("status node mismatch");
    const expiresAt = u64(record.expires_at), active = expiresAt === 0n || timestamp <= expiresAt;
    if (active !== (v[0] === "Active")) throw new Error("inconsistent status expiry");
    state = { kind: active ? "active" : "expired", record: { registrar: address(record.registrar, true), node, holder: address(record.holder), generation: u64(record.generation), expiresAt } };
  } else throw new Error("unknown or malformed status variant");
  return { name: expectedName, ledger, timestamp, state };
}

export function identitiesToScVal(addresses: readonly string[]): xdr.ScVal {
  if (!Array.isArray(addresses) || addresses.length > MAX_BATCH_READS) throw new Error(`provide at most ${MAX_BATCH_READS} identities`);
  return xdr.ScVal.scvVec(addresses.map(value => {
    if (typeof value !== "string") throw new Error("identity must be an address");
    if (StrKey.isValidMed25519PublicKey(value)) {
      const route = decodeMuxedAddress(value);
      return xdr.ScVal.scvVec([nativeToScVal("Muxed", { type: "symbol" }), xdr.ScVal.scvMap([
        new xdr.ScMapEntry({ key: nativeToScVal("account", { type: "symbol" }), val: nativeToScVal(route.account, { type: "address" }) }),
        new xdr.ScMapEntry({ key: nativeToScVal("id", { type: "symbol" }), val: nativeToScVal(BigInt(route.id), { type: "u64" }) }),
      ])]);
    }
    if (!StrKey.isValidEd25519PublicKey(value) && !StrKey.isValidContract(value)) throw new Error("invalid identity address");
    return xdr.ScVal.scvVec([nativeToScVal("Direct", { type: "symbol" }), nativeToScVal(value, { type: "address" })]);
  }));
}

export function batchNamesFromNative(raw: unknown, addresses: readonly string[], canonicalName: (raw: unknown) => string | null, errors: Readonly<Record<number, string>>): BatchNames {
  const r = object(raw, ["ledger", "timestamp", "results"]);
  if (!Array.isArray(r.results) || r.results.length !== addresses.length) throw new Error("batch result length mismatch");
  const results: IdentityName[] = r.results.map((raw, index) => {
    const v = variant(raw), address = addresses[index];
    if (v[0] === "None" && v.length === 1) return { address, kind: "none" };
    if (v[0] === "Name" && v.length === 2) {
      const name = canonicalName(v[1]);
      if (name === null) throw new Error("Name cannot contain null");
      return { address, kind: "name", name };
    }
    if (v[0] === "Failed" && v.length === 2) {
      const errorCode = u32(v[1]);
      if (errorCode === 0) throw new Error("invalid contract error code");
      return { address, kind: "error", errorCode, errorName: errors[errorCode] ?? null };
    }
    throw new Error("unknown or malformed batch variant");
  });
  return { ledger: u32(r.ledger), timestamp: u64(r.timestamp), results };
}
