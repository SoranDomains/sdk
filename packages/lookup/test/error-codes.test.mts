import assert from "node:assert/strict";
import test from "node:test";
import { LOOKUP_ERRORS } from "../src/index.js";
import { contractErrors, describeDrift } from "./helpers/contract-errors.mts";

test("LOOKUP_ERRORS matches the Lookup contract's error enum exactly", () => {
  assert.deepEqual(describeDrift({ ...LOOKUP_ERRORS }, contractErrors("lookup")), []);
});
