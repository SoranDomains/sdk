import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { stdioFeeLimits } from "../src/stdio-env.js";

const BAD = ["0", "050000000", "4294967296", "50000000n", "-1", "1e3", "0x10", "1 2", "١٢٣"];
const NAMES = ["SORAN_MAX_NETWORK_FEE_STROOPS", "SORAN_MAX_NATIVE_FEE_STROOPS"] as const;

test("fee ceilings parse as canonical decimal stroops from 1 to 4294967295 and empty means unset", () => {
  assert.deepEqual(stdioFeeLimits({}), { maxNetworkFeeStroops: undefined, maxNativeFeeStroops: undefined });
  assert.deepEqual(stdioFeeLimits({ SORAN_MAX_NETWORK_FEE_STROOPS: "  ", SORAN_MAX_NATIVE_FEE_STROOPS: "" }), { maxNetworkFeeStroops: undefined, maxNativeFeeStroops: undefined });
  assert.deepEqual(stdioFeeLimits({ SORAN_MAX_NETWORK_FEE_STROOPS: "1", SORAN_MAX_NATIVE_FEE_STROOPS: " 4294967295 " }), { maxNetworkFeeStroops: 1n, maxNativeFeeStroops: 4294967295n });
});

test("malformed fee ceilings are refused with the variable named", () => {
  for (const name of NAMES) for (const value of BAD)
    assert.throws(() => stdioFeeLimits({ [name]: value }), new RegExp(`^Error: ${name} must be canonical decimal stroops between 1 and 4294967295$`), `${name}=${value}`);
});

/** One real process per variable proves stdio.ts actually applies the parser before registering any signing tool.
 *  It runs the source through tsx (no build needed) with a generous limit: only a hang can fail it, never load. */
function runStdio(env: Record<string, string>): Promise<{ code: number | null; stderr: string }> {
  const cwd = fileURLToPath(new URL("..", import.meta.url));
  return new Promise(resolve => {
    execFile(process.execPath, ["--import", "tsx", "src/stdio.ts"], { cwd, env: { ...process.env, ...env }, timeout: 120_000, encoding: "utf8" },
      (error, _stdout, stderr) => resolve({ code: error ? (typeof error.code === "number" ? error.code : -1) : 0, stderr }));
  });
}
for (const name of NAMES) test(`stdio exits before serving when ${name} is malformed`, async () => {
  const { code, stderr } = await runStdio({ [name]: "050000000" });
  assert.notEqual(code, 0);
  assert.match(stderr, new RegExp(`${name} must be canonical decimal stroops between 1 and 4294967295`));
});
