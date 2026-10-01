import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

// One trust policy decides which Registrar/Resolver code a namespace may run. The owner SDK holds the
// reviewed source; the holder SDK, the API's vendored funding modules and the web console's vendored copy
// must not diverge from it (the web copy differs only by dropped ".js" import suffixes and is regenerated
// from the holder copy by scripts/sync-funding-sdk.py, whose --check in CI covers holder -> api and web).
const read = (path: string) => readFileSync(new URL(`../../../${path.replace(/^sdk\//, "packages/")}`, import.meta.url), "utf8");

test("owner and holder native-code-policy.ts are byte-identical (API parity is a documented monorepo gate)", () => {
  const owner = read("sdk/owner/src/native-code-policy.ts");
  assert.match(owner, /export async function expectedNativeCode/);
  for (const copy of ["sdk/holder/src/native-code-policy.ts"])
    assert.equal(read(copy), owner, `${copy} differs from sdk/owner/src/native-code-policy.ts; copy the reviewed owner file to the holder and run python3 scripts/sync-funding-sdk.py`);
});
