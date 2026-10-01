import assert from "node:assert/strict";
import test from "node:test";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ApiHttpError, boundedJson } from "../src/http.js";

async function withFetch<T>(impl: typeof fetch, run: () => Promise<T>): Promise<T> {
  const saved = globalThis.fetch;
  globalThis.fetch = impl;
  try { return await run(); } finally { globalThis.fetch = saved; }
}

/** The hosted MCP runs these sources on workerd, which throws on redirect:"error" before sending anything. */
test("no worker-executed MCP source requests redirect:error", () => {
  const dir = fileURLToPath(new URL("../src/", import.meta.url));
  const offenders = readdirSync(dir).filter(file => file.endsWith(".ts"))
    .filter(file => /redirect\s*:\s*["'`]error["'`]/.test(readFileSync(dir + file, "utf8")));
  assert.deepEqual(offenders, []);
});

test("boundedJson works on a runtime without redirect:error and treats any 3xx as a failure", async () => {
  const seen: unknown[] = [];
  const workerd = (respond: () => Response) => (async (_url: string, init?: RequestInit) => {
    if (init?.redirect === "error") throw new TypeError('Invalid redirect value, must be one of "follow" or "manual"');
    seen.push(init?.redirect);
    return respond();
  }) as unknown as typeof fetch;
  await withFetch(workerd(() => new Response(JSON.stringify({ ok: 1 }))), async () => {
    assert.deepEqual(await boundedJson("https://api.example/v1/x"), { ok: 1 });
  });
  for (const status of [301, 302, 307, 308]) {
    await withFetch(workerd(() => new Response(null, { status, headers: { location: "https://evil.example/" } })), async () => {
      await assert.rejects(boundedJson("https://api.example/v1/x"), (e: unknown) => e instanceof ApiHttpError && e.status === status);
    });
  }
  assert.deepEqual([...new Set(seen)], ["manual"]);
});
