/** Canonical multichain address codecs. Run sdk/multichain/sync.mjs after editing.
 * Binary records follow ENSIP-9/11: EVM raw 20 bytes; Bitcoin scriptPubKey;
 * Solana raw 32-byte public key. Stellar retains its separate payment/memo API.
 * These are destination-network mainnet addresses even on Soran testnet.
 */
import { base58, base58xrp, bech32, bech32m, createBase58check } from "@scure/base";
import { sha256 } from "@noble/hashes/sha2.js";
import { keccak_256 } from "@noble/hashes/sha3.js";

export const CHAIN_NETWORKS = Object.freeze(([
  { id: "bitcoin", name: "Bitcoin", coinType: 0, encoding: "bitcoin-script", caip2: "bip122:000000000019d6689c085ae165831e93" },
  { id: "ethereum", name: "Ethereum", coinType: 60, encoding: "evm", caip2: "eip155:1" },
  { id: "solana", name: "Solana", coinType: 501, encoding: "solana", caip2: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" },
  { id: "optimism", name: "Optimism", coinType: 2147483658, encoding: "evm", caip2: "eip155:10" },
  { id: "polygon", name: "Polygon", coinType: 2147483785, encoding: "evm", caip2: "eip155:137" },
  { id: "base", name: "Base", coinType: 2147492101, encoding: "evm", caip2: "eip155:8453" },
  { id: "arbitrum", name: "Arbitrum", coinType: 2147525809, encoding: "evm", caip2: "eip155:42161" },
  { id: "bsc", name: "BNB Smart Chain", coinType: 2147483704, encoding: "evm", caip2: "eip155:56" },
  { id: "avalanche", name: "Avalanche C-Chain", coinType: 2147526762, encoding: "evm", caip2: "eip155:43114" },
  { id: "xrp", name: "XRP Ledger", coinType: 144, encoding: "xrp", caip2: "xrpl:0" },
  { id: "tron", name: "Tron", coinType: 195, encoding: "tron", caip2: "tron:728126428" },
  { id: "arc", name: "Arc", coinType: 2147488690, encoding: "evm", caip2: "eip155:5042" },
  { id: "tempo", name: "Tempo", coinType: 2147487865, encoding: "evm", caip2: "eip155:4217" },
  { id: "xrpl-evm", name: "XRPL EVM", coinType: 2148923648, encoding: "evm", caip2: "eip155:1440000" },
] as const).map(network => Object.freeze(network)));
export type ChainNetwork = typeof CHAIN_NETWORKS[number]["id"];
export type ChainAddressErrorCode = "UNSUPPORTED_NETWORK" | "INVALID_ADDRESS" | "INVALID_POLICY";
export class ChainAddressError extends Error {
  constructor(message: string, readonly code: ChainAddressErrorCode) { super(message); this.name = "ChainAddressError"; }
}
export function chainNetwork(id: string): typeof CHAIN_NETWORKS[number] {
  const network = CHAIN_NETWORKS.find(network => network.id === id);
  if (!network) throw new ChainAddressError(`unsupported address network: ${String(id)}`, "UNSUPPORTED_NETWORK");
  return network;
}
/** Strictly decode the native Vec<u32> policy; never silently discard unknown networks. */
export function chainPolicyFromNative(raw: unknown): ChainNetwork[] {
  if (!Array.isArray(raw) || raw.length > CHAIN_NETWORKS.length)
    throw new ChainAddressError("invalid chain policy: expected supported coin types", "INVALID_POLICY");
  const seen = new Set<number>();
  return Array.from(raw, coin => {
    const network = CHAIN_NETWORKS.find(network => network.coinType === coin);
    if (typeof coin !== "number" || !Number.isInteger(coin) || !network || seen.has(coin))
      throw new ChainAddressError("invalid chain policy: unknown or duplicate coin type", "INVALID_POLICY");
    seen.add(coin);
    return network.id;
  });
}
export function chainPolicyToNative(networks: readonly ChainNetwork[]): number[] {
  if (!Array.isArray(networks) || networks.length > CHAIN_NETWORKS.length)
    throw new ChainAddressError("invalid chain policy", "INVALID_POLICY");
  const coins = Array.from(networks, network => chainNetwork(network).coinType);
  chainPolicyFromNative(coins);
  return coins;
}
const btc58 = createBase58check(sha256);
const hex = (bytes: Uint8Array) => Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
const fromHex = (value: string) => Uint8Array.from(value.match(/../g)!, part => Number.parseInt(part, 16));
const nonzero = (bytes: Uint8Array) => bytes.some(byte => byte !== 0);
const invalid = (message: string): never => { throw new ChainAddressError(message, "INVALID_ADDRESS"); };
function evmChecksum(bytes: Uint8Array): string {
  const lower = hex(bytes);
  const digest = hex(keccak_256(new TextEncoder().encode(lower)));
  return "0x" + [...lower].map((char, index) => Number.parseInt(digest[index], 16) >= 8 ? char.toUpperCase() : char).join("");
}
function encodeBitcoin(address: string): Uint8Array {
  if (/^(bc1|tb1|bcrt1)/i.test(address)) {
    // The checksum encoding is tied to witness version: BIP173 v0, BIP350 v1.
    let decoded: { prefix: string; words: number[] };
    let variant: 0 | 1;
    try { decoded = bech32.decode(address as `${string}1${string}`); variant = 0; }
    catch { decoded = bech32m.decode(address as `${string}1${string}`); variant = 1; }
    if (decoded.prefix !== "bc") return invalid("Bitcoin address must use mainnet");
    const version = decoded.words[0];
    if (version !== variant) return invalid("unsupported Bitcoin witness version or checksum");
    const program = bech32.fromWords(decoded.words.slice(1));
    if ((version === 0 && program.length !== 20 && program.length !== 32) || (version === 1 && program.length !== 32))
      return invalid("invalid Bitcoin witness program length");
    return Uint8Array.from([version === 0 ? 0 : 0x51, program.length, ...program]);
  }
  const decoded = btc58.decode(address);
  if (decoded.length !== 21) return invalid("invalid Bitcoin address length");
  if (decoded[0] === 0) return Uint8Array.from([0x76, 0xa9, 0x14, ...decoded.slice(1), 0x88, 0xac]);
  if (decoded[0] === 5) return Uint8Array.from([0xa9, 0x14, ...decoded.slice(1), 0x87]);
  return invalid("Bitcoin address must use mainnet");
}
function decodeBitcoin(bytes: Uint8Array): string {
  if (bytes.length === 25 && bytes[0] === 0x76 && bytes[1] === 0xa9 && bytes[2] === 0x14 && bytes[23] === 0x88 && bytes[24] === 0xac)
    return btc58.encode(Uint8Array.from([0, ...bytes.slice(3, 23)]));
  if (bytes.length === 23 && bytes[0] === 0xa9 && bytes[1] === 0x14 && bytes[22] === 0x87)
    return btc58.encode(Uint8Array.from([5, ...bytes.slice(2, 22)]));
  if (bytes[0] === 0 && (bytes[1] === 20 || bytes[1] === 32) && bytes.length === bytes[1] + 2)
    return bech32.encode("bc", [0, ...bech32.toWords(bytes.slice(2))]);
  if (bytes[0] === 0x51 && bytes[1] === 32 && bytes.length === 34)
    return bech32m.encode("bc", [1, ...bech32m.toWords(bytes.slice(2))]);
  return invalid("unsupported or malformed Bitcoin scriptPubKey");
}
/** XRP keeps the version prefix and full X-address tag payload. A classic
 * address alone cannot represent an exchange's required destination tag. */
function validateXrp(bytes: Uint8Array): void {
  if (bytes.length === 21 && bytes[0] === 0 && nonzero(bytes.slice(1))) return;
  if (bytes.length === 31 && bytes[0] === 5 && bytes[1] === 0x44 && nonzero(bytes.slice(2, 22)) &&
      (bytes[22] === 0 || bytes[22] === 1) && !nonzero(bytes.slice(27)) &&
      (bytes[22] === 1 || !nonzero(bytes.slice(23, 27)))) return;
  return invalid("invalid XRP classic or mainnet X-address payload");
}
function encodeXrp(bytes: Uint8Array): string {
  validateXrp(bytes);
  return base58xrp.encode(Uint8Array.from([...bytes, ...sha256(sha256(bytes)).slice(0, 4)]));
}
function decodeXrp(address: string): Uint8Array {
  const decoded = base58xrp.decode(address);
  if (decoded.length !== 25 && decoded.length !== 35) return invalid("invalid XRP address length");
  const bytes = decoded.slice(0, -4);
  const checksum = sha256(sha256(bytes)).slice(0, 4);
  if (!checksum.every((byte, index) => byte === decoded[bytes.length + index])) return invalid("invalid XRP address checksum");
  validateXrp(bytes);
  if (encodeXrp(bytes) !== address) return invalid("noncanonical XRP address");
  return bytes;
}
function validateTron(bytes: Uint8Array): void {
  if (bytes.length !== 21 || bytes[0] !== 0x41 || !nonzero(bytes.slice(1))) return invalid("invalid Tron address payload");
}
/** Validate and encode an explicitly selected destination network. Never infer a network. */
export function encodeChainAddress(network: ChainNetwork, address: string): Uint8Array {
  const metadata = chainNetwork(network);
  if (typeof address !== "string" || address.length === 0 || address.length > 128 || /\s/.test(address))
    return invalid("address must be a nonempty string without whitespace");
  try {
    if (metadata.encoding === "bitcoin-script") return encodeBitcoin(address);
    if (metadata.encoding === "xrp") return decodeXrp(address);
    if (metadata.encoding === "tron") {
      const bytes = btc58.decode(address);
      validateTron(bytes);
      if (!address.startsWith("T") || btc58.encode(bytes) !== address) return invalid("Tron address must use canonical T format");
      return bytes;
    }
    if (metadata.encoding === "solana") {
      const bytes = base58.decode(address);
      if (bytes.length !== 32 || !nonzero(bytes) || base58.encode(bytes) !== address) return invalid("invalid Solana public key");
      return bytes;
    }
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return invalid("EVM address must contain 0x and 40 hexadecimal digits");
    const bytes = fromHex(address.slice(2));
    if (!nonzero(bytes)) return invalid("zero EVM address is not a payment destination");
    const body = address.slice(2);
    if (body !== body.toLowerCase() && body !== body.toUpperCase() && address !== evmChecksum(bytes))
      return invalid("invalid EIP-55 address checksum");
    return bytes;
  } catch (error) {
    if (error instanceof ChainAddressError) throw error;
    return invalid(`invalid ${metadata.name} address or checksum`);
  }
}
/** Strictly decode native binary records to their canonical human-readable form. */
export function decodeChainAddress(network: ChainNetwork, bytes: Uint8Array): string {
  const metadata = chainNetwork(network);
  if (!(bytes instanceof Uint8Array)) return invalid("chain address must be native bytes");
  if (metadata.encoding === "bitcoin-script") return decodeBitcoin(bytes);
  if (metadata.encoding === "xrp") return encodeXrp(bytes);
  if (metadata.encoding === "tron") { validateTron(bytes); return btc58.encode(bytes); }
  if (metadata.encoding === "solana") {
    if (bytes.length !== 32 || !nonzero(bytes)) return invalid("invalid Solana public key bytes");
    return base58.encode(bytes);
  }
  if (bytes.length !== 20 || !nonzero(bytes)) return invalid("invalid EVM address bytes");
  return evmChecksum(bytes);
}
