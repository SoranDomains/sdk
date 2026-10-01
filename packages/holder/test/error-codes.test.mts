import assert from "node:assert/strict";
import test from "node:test";
import { NATIVE_REGISTRAR_ERRORS } from "../src/native-codec.js";
import { contractErrors, describeDrift, sourceErrorCodes, sourceErrorMap } from "../../lookup/test/helpers/contract-errors.mts";

// Numeric handling is safe for unknown codes, but an unnamed `contract error #N` hides what failed.
const maps: Array<[string, string, () => Record<number, string>]> = [
  ["registrar", "REGISTRAR_ERRORS", () => sourceErrorMap("sdk/holder/src/index.ts", "REGISTRAR_ERRORS")],
  ["resolver", "RESOLVER_ERRORS", () => sourceErrorMap("sdk/holder/src/index.ts", "RESOLVER_ERRORS")],
  ["lookup", "LOOKUP_IDENTITY_ERRORS", () => sourceErrorMap("sdk/holder/src/index.ts", "LOOKUP_IDENTITY_ERRORS")],
  ["primary", "PRIMARY_ERRORS", () => sourceErrorMap("sdk/holder/src/index.ts", "PRIMARY_ERRORS")],
  ["registrar", "NATIVE_REGISTRAR_ERRORS", () => ({ ...NATIVE_REGISTRAR_ERRORS })],
];
for (const [contract, name, actual] of maps)
  test(`holder ${name} matches the ${contract} contract's error enum exactly`, () => assert.deepEqual(describeDrift(actual(), contractErrors(contract)), []));

test("FUNDING_ERRORS describes every Funding contract error and nothing else", () => {
  // Funding messages are human sentences, so only the code set is compared.
  assert.deepEqual(sourceErrorCodes("sdk/holder/src/funding-types.ts", "FUNDING_ERRORS"), Object.keys(contractErrors("funding")).map(Number));
});
