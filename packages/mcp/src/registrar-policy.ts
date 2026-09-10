/** Construction-time Registrar policy. Keep the API, MCP and web copies identical. */
export type RegistrarPolicy = {
  default_term_secs: string;
  reclaimable: boolean;
  trade_fee_bps: number;
  tradeable: boolean;
  transferable: boolean;
};
export type RegistrarPolicyInput = "reclaimable" | "permanent" | Omit<RegistrarPolicy, "default_term_secs"> & { default_term_secs: string | number };
const fields = ["default_term_secs", "reclaimable", "trade_fee_bps", "tradeable", "transferable"] as const;
export function normalizeRegistrarPolicy(input: unknown): RegistrarPolicy {
  if (input === "reclaimable" || input === "permanent") {
    return { default_term_secs: "0", reclaimable: input === "reclaimable", trade_fee_bps: 0, tradeable: false, transferable: true };
  }
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).sort().join() !== fields.join())
    throw new Error("Provide a policy preset or exactly all five Registrar policy fields.");
  const p = input as Record<string, unknown>;
  for (const key of ["reclaimable", "tradeable", "transferable"] as const)
    if (typeof p[key] !== "boolean") throw new Error(key + " must be a boolean.");
  const term = p.default_term_secs;
  if (!((typeof term === "string" && /^(0|[1-9][0-9]{0,9})$/.test(term)) ||
    (typeof term === "number" && Number.isSafeInteger(term) && term >= 0 && !Object.is(term, -0))))
    throw new Error("default_term_secs must be a canonical decimal string or a non-negative whole number.");
  const seconds = BigInt(term as string | number);
  if (seconds !== 0n && (seconds < 86400n || seconds > 3153600000n))
    throw new Error("default_term_secs must be 0 (no expiry), or 86400 through 3153600000 seconds.");
  if (typeof p.trade_fee_bps !== "number" || !Number.isInteger(p.trade_fee_bps) || p.trade_fee_bps < 0 || p.trade_fee_bps > 10000 || Object.is(p.trade_fee_bps, -0))
    throw new Error("trade_fee_bps must be a whole number from 0 to 10000.");
  return { default_term_secs: seconds.toString(), reclaimable: p.reclaimable as boolean, trade_fee_bps: p.trade_fee_bps, tradeable: p.tradeable as boolean, transferable: p.transferable as boolean };
}
export function sameRegistrarPolicy(actual: unknown, expected: RegistrarPolicy): boolean {
  try { return JSON.stringify(normalizeRegistrarPolicy(actual)) === JSON.stringify(normalizeRegistrarPolicy(expected)); }
  catch { return false; }
}
/** Map a decoded contract value into the same validated JSON representation. */
export function registrarPolicyFromNative(actual: unknown): RegistrarPolicy {
  if (!actual || typeof actual !== "object" || Array.isArray(actual)) throw new Error("Invalid on-chain Registrar policy.");
  const p = actual as Record<string, unknown>;
  if (Object.keys(p).sort().join() !== fields.join() || typeof p.default_term_secs !== "bigint")
    throw new Error("Invalid on-chain Registrar policy fields.");
  return normalizeRegistrarPolicy({ ...p, default_term_secs: p.default_term_secs.toString() });
}
