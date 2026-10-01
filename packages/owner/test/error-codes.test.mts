import assert from "node:assert/strict";
import test from "node:test";
import { NATIVE_REGISTRAR_ERRORS } from "../src/native-codec.js";
import { contractErrors, describeDrift, sourceErrorMap } from "../../lookup/test/helpers/contract-errors.mts";

// Numeric handling is safe for unknown codes, but an unnamed `contract error #N` hides what failed.
const maps: Array<[string, string, () => Record<number, string>]> = [
  ["registrar", "REGISTRAR_ERRORS", () => sourceErrorMap("sdk/owner/src/index.ts", "REGISTRAR_ERRORS")],
  ["registry", "REGISTRY_ERRORS", () => sourceErrorMap("sdk/owner/src/index.ts", "REGISTRY_ERRORS")],
  ["registrar", "NATIVE_REGISTRAR_ERRORS", () => ({ ...NATIVE_REGISTRAR_ERRORS })],
];
for (const [contract, name, actual] of maps)
  test(`owner ${name} matches the ${contract} contract's error enum exactly`, () => assert.deepEqual(describeDrift(actual(), contractErrors(contract)), []));
