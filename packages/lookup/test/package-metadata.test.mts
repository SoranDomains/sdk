import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";

/**
 * npm shows `repository` on the package page and requires it to name a PUBLIC repository for provenance. The
 * monorepo (SoranDomains/soran) is private, so the metadata names the public mirror (SoranDomains/sdk, layout
 * packages/<name>) that the same code is published from. `homepage` and `bugs` already point there; the three
 * must agree, and the source directory in this monorepo must exist for the mirror to be produced from.
 */
for (const pkg of ["lookup", "owner", "holder", "mcp"]) test(`@sorandomains/${pkg} repository points at the public mirror and its own directory there`, () => {
  const manifest = JSON.parse(readFileSync(new URL(`../../${pkg}/package.json`, import.meta.url), "utf8"));
  assert.equal(manifest.name, `@sorandomains/${pkg}`);
  assert.deepEqual(manifest.repository, { type: "git", url: "git+https://github.com/SoranDomains/sdk.git", directory: `packages/${pkg}` });
  assert.equal(manifest.homepage, `https://github.com/SoranDomains/sdk/tree/main/packages/${pkg}#readme`);
  assert.equal(manifest.bugs.url, "https://github.com/SoranDomains/sdk/issues");
  assert.ok(existsSync(new URL(`../../../packages/${pkg}/package.json`, import.meta.url)), "the package's source directory must exist in this repository");
});
