import { StrKey } from "@stellar/stellar-sdk";

export type NamespacePolicy = { reclaimable: boolean; transferable: boolean; tradeable: boolean; defaultTermSecs: bigint; tradeFeeBps: number };
export type NamespaceMetadata = {
  namespace: string; node: string; owner: string; registrar: string | null; resolver: string | null;
  resolverAttested: boolean; resolverLocked: boolean; registrarTainted: boolean; resolverTainted: boolean;
  permanent: boolean; policy: NamespacePolicy | null;
};
export type NameMetadata = {
  name: string; node: string; registrar: string; holder: string; builtinAddress: string;
  generation: bigint; expiresAt: bigint; active: boolean; noExpiry: boolean; namespacePermanent: boolean;
};
function object(raw: unknown, fields: string): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).sort().join(",") !== fields.split(",").sort().join(","))
    throw new Error("unexpected metadata fields");
  return raw as Record<string, unknown>;
}
export function address(raw: unknown, contract = false): string {
  if (typeof raw !== "string" || !(StrKey.isValidContract(raw) || (!contract && StrKey.isValidEd25519PublicKey(raw)))) throw new Error("invalid metadata address");
  return raw;
}
function optionalAddress(raw: unknown): string | null { return raw === null ? null : address(raw, true); }
function bool(raw: unknown): boolean { if (typeof raw !== "boolean") throw new Error("invalid metadata boolean"); return raw; }
export function u64(raw: unknown): bigint {
  if (typeof raw !== "bigint" || raw < 0n || raw > 18446744073709551615n) throw new Error("invalid exact u64");
  return raw;
}
function node(raw: unknown, expected: string): string {
  if (!(raw instanceof Uint8Array) || raw.length !== 32) throw new Error("invalid metadata node");
  const value = Array.from(raw, b => b.toString(16).padStart(2, "0")).join("");
  if (value !== expected) throw new Error("metadata node mismatch");
  return value;
}
export function namespaceFromNative(raw: unknown, expected: string, expectedNode: string): NamespaceMetadata | null {
  if (raw === null) return null;
  const r = object(raw, "namespace,node,owner,registrar,resolver,resolver_attested,resolver_locked,registrar_tainted,resolver_tainted,permanent,policy");
  if (r.namespace !== expected) throw new Error("metadata namespace mismatch");
  let policy: NamespacePolicy | null = null;
  if (r.policy !== null) {
    const p = object(r.policy, "reclaimable,transferable,tradeable,default_term_secs,trade_fee_bps");
    if (typeof p.trade_fee_bps !== "number" || !Number.isInteger(p.trade_fee_bps) || p.trade_fee_bps < 0 || p.trade_fee_bps > 10000) throw new Error("invalid policy fee");
    policy = { reclaimable: bool(p.reclaimable), transferable: bool(p.transferable), tradeable: bool(p.tradeable), defaultTermSecs: u64(p.default_term_secs), tradeFeeBps: p.trade_fee_bps };
  }
  const registrar = optionalAddress(r.registrar);
  if (registrar === null && policy !== null) throw new Error("policy without Registrar");
  return { namespace: expected, node: node(r.node, expectedNode), owner: address(r.owner), registrar,
    resolver: optionalAddress(r.resolver), resolverAttested: bool(r.resolver_attested), resolverLocked: bool(r.resolver_locked),
    registrarTainted: bool(r.registrar_tainted), resolverTainted: bool(r.resolver_tainted), permanent: bool(r.permanent), policy };
}
export function nameFromNative(raw: unknown, expected: string, expectedNode: string): NameMetadata | null {
  if (raw === null) return null;
  const r = object(raw, "name,node,registrar,holder,builtin_address,generation,expires_at,active,no_expiry,namespace_permanent");
  if (r.name !== expected) throw new Error("metadata name mismatch");
  const expiresAt = u64(r.expires_at), noExpiry = bool(r.no_expiry);
  if (noExpiry !== (expiresAt === 0n)) throw new Error("inconsistent expiry metadata");
  return { name: expected, node: node(r.node, expectedNode), registrar: address(r.registrar, true), holder: address(r.holder),
    builtinAddress: address(r.builtin_address), generation: u64(r.generation), expiresAt, active: bool(r.active), noExpiry, namespacePermanent: bool(r.namespace_permanent) };
}
