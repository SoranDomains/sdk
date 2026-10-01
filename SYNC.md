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
this source sync. Existing MCP and native-signup example trees stay unchanged.

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
5. Only after these three versions are available, prepare MCP **0.10.0** with
   exact published dependencies in a separate reviewed sync and publication.

The current documented route is local npm publication. It does **not** generate
GitHub CI provenance, and this release must not claim that it does. A future
trusted-publisher workflow needs separate reviewed configuration and a matching
public repository/workflow identity. No publishing workflow or credential
administration is introduced here.
