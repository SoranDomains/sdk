# Public SDK source sync

This release exports core SDK source from reviewed monorepo commit
`cec2d29bd392c64ac3e7f8d1d20d626736c72ce5`. The public mirror started at
`70b702194cbb349a0bc3a6221109dd978e57babc`.

`sync-manifest.json` lists every exported source path, destination, original SHA-256,
and final SHA-256. All Lookup, Owner and Holder production source files are byte
identical to the reviewed source. The core package versions are Lookup **0.11.0**,
Owner **0.12.0** and Holder **0.10.0**. All require Node **22.12 or later**.

The allowlist contains these three package trees, the public hint-server examples,
the SDK README/native-claims/network documentation and the reviewed testnet
manifest. Private API implementation and Rust contract source are not exported.
No generated `dist`, dependencies, local environment files or credentials enter
this source sync. MCP and native-signup are exported separately as described below.

## Portable tests

The test adaptations are explicit in `test-manifest.json`:

- Source-directory and example links change from the monorepo layout to the
  public `packages/` and `examples/` layout.
- Error-code tests compare against exported public ABI enum names and numbers in
  `fixtures/public-abi-errors.json`. Each enum records the exact source-file hash.
- Owner upgrade lineage compares against exported public catalog metadata and
  reviewed artifact hashes, with the original source-file hashes recorded.
- Owner/Holder code-policy parity still runs locally. The API vendor parity and
  source ABI/catalog comparisons remain required monorepo CI checks.

These fixtures are evidence of the reviewed source snapshot, not a claim that
public CI recompiled private contracts or ran the private API. `node
scripts/verify-sync.mjs` checks the projection and fixtures; its negative tests
reject source/fixture drift and invalid mappings. The package suites still run
all portable tests. No test is silently skipped.

## Release procedure

1. Confirm full monorepo CI for the exact export source or a merge with the exact
   same Git tree. Retain its run identity and results outside public source.
2. Review this mirror diff and `test-manifest.json`; pass mirror CI, clean builds,
   browser checks and high/critical audits for the three new packages.
3. From a clean merged mirror checkout, pack each package and retain the tarball
   SHA-256, npm integrity, file inventory, source commit and test receipts.
4. Publish the exact reviewed tarballs under the authenticated account, honoring
   any npm 2FA challenge. Check each version and integrity in the registry. Never
   put authentication values in source, logs or a release receipt.
5. MCP **0.10.0** uses the three published core versions as exact registry
   dependencies. Apply the same review, CI, archive and registry verification
   gates to each second-stage release before publication.

The current documented route is local npm publication. It does **not** generate
GitHub CI provenance, and this release must not claim that it does. A future
trusted-publisher workflow needs separate reviewed configuration and a matching
public repository/workflow identity. No publishing workflow or credential
administration is introduced here.

## MCP second-stage source

Lookup 0.11.0, Owner 0.12.0, Holder 0.10.0 and MCP 0.10.0 were published on
1 October 2026. MCP was published at 12:15:28.309 UTC; its downloaded registry
archive and integrity exactly match the reviewed archive. The publication record
is in `mcp-sync-manifest.json`. MCP is exported from monorepo commit
`9cc027804f2e7363f1cabcd99eb25839355e3f0b` onto public mirror base
`891330d5451ff3b9f3b4285c5811298a1d972846`.

`mcp-sync-manifest.json` records all 37 MCP and six native-signup files, exact
source/destination hashes, the core dependency versions/integrities, and the
shared Holder fixture. Every MCP runtime and portable test byte is unchanged;
the MCP README has one public-layout link correction. The native-signup example
is byte-identical to the same source commit and uses the published core packages.

The shared README/native-claims documents have explicit per-file source revisions
and retained previous mappings. The default core source revision, its production
files and ABI/catalog fixture provenance remain pinned to `cec2d29`. This second
stage does not republish or alter the three core archives.

The one omitted MCP test, `sdk/mcp/test/api-recovery.test.mts`, imports private API
implementation. Its hash and required source-CI gate are explicit in both
manifests; public CI does not claim to run it. All 16 other MCP test files are
exported unchanged. Two existing public-only regression files also remain: the
submission test is unchanged; the session-ordering fixture explicitly disables
the new confirmation gate, which has its own source test suite. Both retain their
public source hashes and adaptation details in the manifests. All 18 files run
through the unchanged package test command. Public
CI verifies both projections, builds/types/tests all four packages, audits all
packages at the high/critical threshold and checks the native-signup example.

Run `node scripts/verify-mcp-sync.mjs` and its adjacent negative tests in addition
to the core verifier. Before MCP publication, require full monorepo CI for the
recorded source or a merge with the same Git tree, public mirror CI, and exact
packed JavaScript/declaration parity against the reviewed source build.

The publication-status update changes shared documentation and its derived hashes
only. All package files and their source mappings, test fixtures and the reviewed
npm archive remain unchanged from public release merge
`2874fe4c5cb7a4253a0f685da95339e96314bc0f`. The MCP manifest retains the prior
shared-document hashes for that release. Hosted rollout verification is separate
and is not implied by npm publication.
