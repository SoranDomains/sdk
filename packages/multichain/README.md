# Native network address records

This source adds optional multichain records to Soran's native Resolver and
Universal Lookup. It needs contracts with `multichain_version() == 1`. The existing
published deployment presets have not been redeployed by this change; supplying a
verified compatible deployment is required until a release publishes new pins.
Installing the SDK alone does not upgrade deployed contracts.

The namespace owner sets one live `Vec<u32>` allowlist with `set_chain_policy`.
It starts empty and applies to every current and future holder. Disabling a network
immediately hides its records and prevents new writes. Stored values are preserved
for re-enablement; the current holder can clear them while disabled. Records are
bound to the name's ownership generation. Transfers/reclaims/reissuance invalidate
old records; expiry makes reads fail. The namespace owner never sets a holder's
receiving address through this policy.

The Holder, Lookup and Owner packages export `CHAIN_NETWORKS`, `ChainNetwork`, `chainNetwork`,
`encodeChainAddress`, `decodeChainAddress`, `chainPolicyFromNative` and
`chainPolicyToNative`. Network IDs are explicit: there is no default address,
network guessing, text-record fallback, or Ethereum fallback for another EVM chain.
These records publish destinations; they do not send, bridge, swap, or prove
ownership of a destination account.

| Network ID | Destination network | ENS coin type | Stored bytes |
| --- | --- | ---: | --- |
| `bitcoin` | Bitcoin mainnet | 0 | Standard scriptPubKey |
| `ethereum` | Ethereum mainnet | 60 | 20-byte EVM address |
| `solana` | Solana mainnet | 501 | 32-byte public key |
| `optimism` | Optimism mainnet | 2147483658 | 20-byte EVM address |
| `polygon` | Polygon mainnet | 2147483785 | 20-byte EVM address |
| `base` | Base mainnet | 2147492101 | 20-byte EVM address |
| `arbitrum` | Arbitrum One | 2147525809 | 20-byte EVM address |
| `bsc` | BNB Smart Chain mainnet | 2147483704 | 20-byte EVM address |
| `avalanche` | Avalanche C-Chain mainnet | 2147526762 | 20-byte EVM address |
| `xrp` | XRP Ledger mainnet | 144 | Version-inclusive classic or X-address payload |
| `tron` | Tron mainnet | 195 | 21-byte payload including 0x41 |
| `arc` | Arc mainnet | 2147488690 | 20-byte EVM address |
| `tempo` | Tempo mainnet | 2147487865 | 20-byte EVM address |
| `xrpl-evm` | XRPL EVM mainnet | 2148923648 | 20-byte EVM address |

The Soran deployment may be on Stellar testnet; these IDs still identify the listed
destination mainnets. EVM, Solana, classic XRP and Tron address formats alone cannot
prove which network the recipient intended. Obtain the address for the selected
network from the recipient. Bitcoin testnet addresses and XRP testnet X-addresses
are rejected. Avalanche support is C-Chain, not X-Chain/P-Chain; BNB support is Smart
Chain, not Beacon Chain.

Bitcoin accepts checked P2PKH, P2SH, SegWit v0 (20 or 32-byte program), and Taproot
v1 (32-byte program); other witness/script forms fail closed. EVM accepts all-lower
or all-upper hex and validates mixed-case EIP-55, returning canonical EIP-55.
Solana is canonical base58 of exactly 32 nonzero bytes. Zero EVM, Solana, XRP account
and Tron destinations are rejected.

XRP Ledger is distinct from XRPL EVM. Classic `r...` stores 21 bytes including its
0x00 version; it contains **no destination tag**. When a recipient requires a tag,
publish their mainnet `X...` address, which stores all 31 payload bytes (0x0544,
20-byte account, tag flag, little-endian u32 tag and reserved zeros). A tag of zero
is preserved separately from an absent tag. Readers return the full X-address and
must never reduce it to an `r...` address or drop the embedded tag. There is no
separate destination-tag text record or inference. Tron accepts checked `T...`
Base58Check addresses, not EVM `0x...` strings.

Stellar remains on `setPayment` / `resolvePayment` with its complete G/C/muxed and
memo semantics. `stellar` is intentionally not a generic network ID here.

## Relationship to ENS

Soran uses ENS-style per-network records and the coin identifiers described by
SLIP-44/ENSIP-11. Its contract methods, name hashing, namespace policy, errors and
Stellar transaction format are Soran-native. This is not an ENS resolver interface
and existing ENS wallets need an explicit Soran integration.

The supported address payloads use the referenced ENS encoding conventions. In
particular, [ENSIP-9's Ripple section](https://docs.ens.domains/ensip/9/#ripple) and
the [ENS XRP address codec](https://github.com/ensdomains/address-encoder/blob/master/src/coin/xrp.ts)
retain version bytes: a classic XRP payload is 21 bytes, not a bare 20-byte account
ID. X-address payloads also retain the tag. Soran validates a narrower set of
formats, mainnet prefixes and nonzero destinations than a generic binary encoder;
matching one payload encoding does not imply complete ENS protocol compatibility.

The existing MCP server has no new multichain tools in this change. The public
integration surfaces added here are the native contracts, the three SDKs, the HTTP
API and the web interface.

## Maintenance and verification

Edit `sdk/multichain/addresses.ts`, then run `node sdk/multichain/sync.mjs` from the
repository root. The five copied modules allow each independently published SDK,
the API and the web app to bundle the exact same browser-safe codec. Check for
copy drift using `node sdk/multichain/sync.mjs --check`. Dependencies are pinned
`@scure/base` and `@noble/hashes` 2.4.0, with Node >=20.19 required by noble hashes.

Run `npm run build`, `npm test`, and `npm run check:browser` in each of
`sdk/holder`, `sdk/owner`, and `sdk/lookup`. Codec vectors live in Lookup's
`test/multichain-codec.test.mts`; each package also tests its native method routing,
strict result shapes, policy gating, and signing intent where applicable.

Encoding references:
[ENSIP-9](https://docs.ens.domains/ensip/9/),
[ENSIP-11](https://docs.ens.domains/ensip/11/),
[ERC-55](https://eips.ethereum.org/EIPS/eip-55),
[BIP-350](https://github.com/bitcoin/bips/blob/master/bip-0350.mediawiki),
[XRPLF X-address codec](https://github.com/XRPLF/xrpl.js/blob/main/packages/ripple-address-codec/src/index.ts),
[Tron accounts](https://developers.tron.network/docs/account).
