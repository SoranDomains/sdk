import assert from "node:assert/strict";
import test from "node:test";
import { base58, bech32, bech32m, createBase58check } from "@scure/base";
import { sha256 } from "@noble/hashes/sha2.js";
import { CHAIN_NETWORKS, ChainAddressError, chainNetwork, chainPolicyFromNative, chainPolicyToNative, encodeChainAddress, decodeChainAddress } from "../src/index.js";
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
// Official ERC-55 examples: https://eips.ethereum.org/EIPS/eip-55
const evmVectors = ["0x52908400098527886E0F7030069857D2E4169EE7", "0x8617E340B3D01FA5F11F306F4090FD50E238070D", "0xde709f2102306220921060314715629080e2fb77", "0x27b1fdb04752bbc536007a920d24acb045561c26", "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed", "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359", "0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB", "0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb"];
test("all EVM networks validate ERC-55 vectors and store raw20, not UTF-8", () => {
  for (const network of CHAIN_NETWORKS.filter(n => n.encoding === "evm")) for (const address of evmVectors) {
    assert.equal(hex(encodeChainAddress(network.id, address)), address.slice(2).toLowerCase());
    assert.equal(decodeChainAddress(network.id, encodeChainAddress(network.id, address.toLowerCase())), address);
  }
  assert.throws(() => encodeChainAddress("ethereum", "0x5AAeb6053F3E94C9b9A09f33669435E7Ef1BeAed"), /checksum/);
  for (const address of ["0x" + "0".repeat(40), "  " + evmVectors[0], evmVectors[0] + "\n", evmVectors[0].slice(2), "0x01", "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF"])
    assert.throws(() => encodeChainAddress("ethereum", address), ChainAddressError);
});
// BIP350 official address/script vectors: https://github.com/bitcoin/bips/blob/master/bip-0350.mediawiki
const bitcoinVectors = [
  ["BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4", "0014751e76e8199196d454941c45d1b3a323f1433bd6"],
  ["bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0", "512079be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"],
  ["1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa", "76a91462e907b15cbf27d5425399ebf6f0fb50ebb88f1888ac"],
  ["3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy", "a914b472a266d0bd89c13706a4132ccfb16f7c3b9fcb87"],
];
test("Bitcoin supports mainnet legacy, SegWit v0 and Taproot standard scripts", () => {
  for (const [address, script] of bitcoinVectors) {
    assert.equal(hex(encodeChainAddress("bitcoin", address)), script);
    assert.equal(decodeChainAddress("bitcoin", Buffer.from(script, "hex")), address.startsWith("BC1") ? address.toLowerCase() : address);
  }
  const script = Uint8Array.from([0, 32, ...new Uint8Array(32).fill(1)]);
  assert.deepEqual(encodeChainAddress("bitcoin", decodeChainAddress("bitcoin", script)), script);
});
test("Bitcoin rejects wrong networks, checksum variants, future scripts, padding and corruption", () => {
  const program = new Uint8Array(32).fill(1);
  const invalid = [
    "bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqh2y7hd", // v1 Bech32
    "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kemeawh", // v0 Bech32m
    "bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7v07qwwzcrf", // excess padding
    "bC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4", // mixed case
    "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNb", // Base58 checksum
    bech32.encode("tb", [0, ...bech32.toWords(program)]),
    bech32m.encode("bcrt", [1, ...bech32m.toWords(program)]),
    bech32m.encode("bc", [2, ...bech32m.toWords(program)]),
    bech32.encode("bc", [0, ...bech32.toWords(new Uint8Array(21))]),
    bech32m.encode("bc", [1, ...bech32m.toWords(new Uint8Array(20))]),
    createBase58check(sha256).encode(Uint8Array.from([111, ...new Uint8Array(20)])),
  ];
  for (const address of invalid) assert.throws(() => encodeChainAddress("bitcoin", address), ChainAddressError, address);
  for (const bytes of [new Uint8Array(), Uint8Array.from([0x51, 20, ...new Uint8Array(20)]), Uint8Array.from([0x52, 32, ...program]), Uint8Array.from([0, 32, ...program, 0])])
    assert.throws(() => decodeChainAddress("bitcoin", bytes), ChainAddressError);
});
test("Solana accepts base58 raw32 and rejects zero, truncation, and noncanonical values", () => {
  const bytes = new Uint8Array(32).fill(7), address = base58.encode(bytes);
  assert.deepEqual(encodeChainAddress("solana", address), bytes);
  assert.equal(decodeChainAddress("solana", bytes), address);
  for (const address of ["1".repeat(32), "1".repeat(31), "1".repeat(33), "O".repeat(32), " " + base58.encode(bytes)])
    assert.throws(() => encodeChainAddress("solana", address), ChainAddressError);
});
test("binary reads and namespace policies fail closed for malformed and unsupported data", () => {
  for (const raw of [undefined, "0x123", [1,2,3], {}, new Uint8Array(), new Uint8Array(20)])
    assert.throws(() => decodeChainAddress("ethereum", raw as Uint8Array), ChainAddressError);
  for (const raw of [undefined, null, {}, new Array(2), [60n], ["60"], [60,60], [42], [2147483658, -1]])
    assert.throws(() => chainPolicyFromNative(raw), ChainAddressError);
  assert.deepEqual(chainPolicyToNative(["bitcoin", "base"]), [0,2147492101]);
  assert.deepEqual(chainPolicyFromNative([0,2147492101]), ["bitcoin","base"]);
  assert.throws(() => chainPolicyToNative(["bitcoin","bitcoin"]), ChainAddressError);
  assert.throws(() => chainNetwork("stellar"), (e: unknown) => e instanceof ChainAddressError && e.code === "UNSUPPORTED_NETWORK");
  assert.equal(Object.isFrozen(CHAIN_NETWORKS), true);
});
// XRPLF official vectors retain classic versus X-address and the entire tag:
// https://github.com/XRPLF/xrpl.js/blob/main/packages/ripple-address-codec/test/index.test.ts
test("XRP Ledger preserves X-address tag flags and u32 tags, including zero", () => {
  const vectors: [string, number | null][] = [
    ["X7AcgcsBL6XDcUb289X4mJ8djcdyKaB5hJDWMArnXr61cqZ", null],
    ["X7AcgcsBL6XDcUb289X4mJ8djcdyKaGZMhc9YTE92ehJ2Fu", 1],
    ["X7AcgcsBL6XDcUb289X4mJ8djcdyKaLFuhLRuNXPrDeJd9A", 11747],
    ["XVLhHMPHU98es4dbozjVtdWzVrDjtV8AqEL4xcZj5whKbmc", 0],
    ["XVLhHMPHU98es4dbozjVtdWzVrDjtV18pX8yuPT7y4xaEHi", 4294967295],
  ];
  for (const [address, tag] of vectors) {
    const bytes = encodeChainAddress("xrp", address);
    assert.equal(bytes.length, 31);
    assert.deepEqual(Array.from(bytes.slice(0, 2)), [5, 0x44]);
    assert.equal(bytes[22], tag === null ? 0 : 1);
    assert.equal(new DataView(bytes.buffer, bytes.byteOffset).getUint32(23, true), tag ?? 0);
    assert.equal(decodeChainAddress("xrp", bytes), address);
  }
  const classic = "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59";
  const classicBytes = encodeChainAddress("xrp", classic);
  assert.equal(classicBytes.length, 21); assert.equal(classicBytes[0], 0);
  assert.equal(decodeChainAddress("xrp", classicBytes), classic);
  for (const address of [classic.slice(0,-1)+"1", "T719a5UwUCnEs54UsxG9CJYYDhwmFCqkr7wxCcNcfZ6p5GZ", "T719a5UwUCnEs54UsxG9CJYYDhwmFCvbJNZbi37gBGkRkbE", evmVectors[0]])
    assert.throws(() => encodeChainAddress("xrp", address), ChainAddressError);
  const tagged = encodeChainAddress("xrp", vectors[1][0]);
  for (const [offset, value] of [[0,4],[1,0x93],[22,2],[27,1]]) {
    const corrupt = new Uint8Array(tagged); corrupt[offset] = value;
    assert.throws(() => decodeChainAddress("xrp", corrupt), ChainAddressError);
  }
  const noTagWithTag = new Uint8Array(tagged); noTagWithTag[22] = 0;
  assert.throws(() => decodeChainAddress("xrp", noTagWithTag), ChainAddressError);
  assert.throws(() => decodeChainAddress("xrp", new Uint8Array(21)), ChainAddressError);
});
test("Tron uses checked T format and raw21 with the 0x41 prefix", () => {
  const address = "TJRabPrwbZy45sbavfcjinPJC18kjpRTv8";
  const bytes = encodeChainAddress("tron", address);
  assert.equal(bytes.length, 21); assert.equal(bytes[0], 0x41);
  assert.equal(decodeChainAddress("tron", bytes), address);
  for (const bad of [address.slice(0,-1)+"9", hex(bytes), evmVectors[0], "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa"])
    assert.throws(() => encodeChainAddress("tron", bad), ChainAddressError);
  assert.throws(() => decodeChainAddress("tron", Uint8Array.from([0x41,...new Uint8Array(20)])), ChainAddressError);
  assert.throws(() => decodeChainAddress("tron", Uint8Array.from([0x42,...new Uint8Array(20).fill(1)])), ChainAddressError);
});
test("XRP Ledger and XRPL EVM are distinct network identities and codecs", () => {
  assert.equal(chainNetwork("xrp").coinType,144);
  assert.equal(chainNetwork("xrpl-evm").coinType,2148923648);
  assert.equal(chainNetwork("arc").coinType,2147488690);
  assert.equal(chainNetwork("tempo").coinType,2147487865);
  assert.throws(()=>encodeChainAddress("xrpl-evm","r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59"),ChainAddressError);
  assert.throws(()=>encodeChainAddress("xrp",evmVectors[0]),ChainAddressError);
});
