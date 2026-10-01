import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

/** The payment tuple codec decides where money goes; the three SDKs carry one reviewed copy by convention, so drift must fail a test. */
test("lookup, holder and owner ship byte-identical payment.ts", () => {
  const read = (pkg: string) => readFileSync(new URL(`../../${pkg}/src/payment.ts`, import.meta.url));
  const lookup = read("lookup");
  for (const pkg of ["holder", "owner"]) assert.ok(lookup.equals(read(pkg)), `sdk/${pkg}/src/payment.ts differs from sdk/lookup/src/payment.ts; copy the reviewed file to all three packages`);
});
