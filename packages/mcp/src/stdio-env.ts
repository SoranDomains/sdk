/** Operator fee ceilings from the environment. An empty (or whitespace) variable is unset, never a real value. */
export function stdioFeeLimits(env: Record<string, string | undefined>): { maxNetworkFeeStroops?: bigint; maxNativeFeeStroops?: bigint } {
  const read = (name: string): bigint | undefined => {
    const value = env[name]?.trim();
    if (!value) return undefined;
    if (!/^[1-9][0-9]{0,9}$/.test(value) || BigInt(value) > 4_294_967_295n)
      throw new Error(`${name} must be canonical decimal stroops between 1 and 4294967295`);
    return BigInt(value);
  };
  return { maxNetworkFeeStroops: read("SORAN_MAX_NETWORK_FEE_STROOPS"), maxNativeFeeStroops: read("SORAN_MAX_NATIVE_FEE_STROOPS") };
}
