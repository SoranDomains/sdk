import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MCP_VERSION } from "../src/tools.js";

test("MCP advertises the published package version", () => {
  const metadata = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(MCP_VERSION, metadata.version);
});
