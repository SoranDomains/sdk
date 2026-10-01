import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { registerReadTools, type ReadToolOptions, type ToolRegistrar } from "../src/tools.js";

// (SM-05) holdings_page verifies every candidate on chain: a full page is about 100 RPC simulations. The hosted,
// unauthenticated server therefore sets a lower ceiling; the local server keeps the full 100. wallet_names embeds the
// same first holdings page (walletProfile -> namesOfPage, 40 candidates by default), so the ceiling bounds it too.
const hintUrl = "http://127.0.0.1:1/fixture";
const address = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H";
type Result = { content: Array<{ type: "text"; text: string }>; isError?: boolean };
function holdingsTool(options: ReadToolOptions) {
  let entry: { schema: z.AnyZodObject; callback: (args: unknown) => Promise<Result> } | undefined;
  const server = { tool(name: string, _description: string, schema: z.ZodRawShape, callback: (args: unknown) => Promise<Result>) {
    if (name === "holdings_page") entry = { schema: z.object(schema), callback };
  } } as ToolRegistrar;
  registerReadTools(server, { hintUrl, ...options });
  return entry!;
}
async function requestedLimit(options: ReadToolOptions, args: Record<string, unknown>): Promise<number> {
  const tool = holdingsTool(options);
  const original = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = (async (url: string) => {
    urls.push(String(url));
    return new Response(JSON.stringify({ holder: address, names: [], nextCursor: null, hasMore: false, coverage: { source: "indexed", complete: true, processedLedger: 1, headLedger: 1, gaps: [] } }));
  }) as typeof fetch;
  try { await tool.callback(tool.schema.parse({ address, ...args })); } finally { globalThis.fetch = original; }
  assert.equal(urls.length, 1);
  return Number(new URL(urls[0]).searchParams.get("limit"));
}

test("the local default still accepts a full 100-name page and defaults to 40", async () => {
  const tool = holdingsTool({});
  assert.equal(tool.schema.safeParse({ address, limit: 100 }).success, true);
  assert.equal(tool.schema.safeParse({ address, limit: 101 }).success, false);
  assert.equal(await requestedLimit({}, {}), 40);
  assert.equal(await requestedLimit({}, { limit: 100 }), 100);
});

test("a hosted ceiling bounds the accepted limit and the default page", async () => {
  const hosted = { maxHoldingsPageLimit: 25 };
  const tool = holdingsTool(hosted);
  assert.equal(tool.schema.safeParse({ address, limit: 25 }).success, true);
  assert.equal(tool.schema.safeParse({ address, limit: 26 }).success, false, "a caller cannot ask for more than the ceiling");
  assert.equal(await requestedLimit(hosted, {}), 25, "an omitted limit is the ceiling, not the SDK's 40");
  assert.equal(await requestedLimit(hosted, { limit: 10 }), 10);
  assert.equal(await requestedLimit({ maxHoldingsPageLimit: 60 }, {}), 40, "above the SDK default nothing changes");
});

/** The hint page request (`.../v1/names/by-holder/<address>?limit=N`) the wallet_names handler makes; chain reads fail fast. */
async function walletNamesHoldingsLimit(options: ReadToolOptions): Promise<number> {
  let entry: ((args: unknown) => Promise<Result>) | undefined;
  const server = { tool(name: string, _description: string, _schema: z.ZodRawShape, callback: (args: unknown) => Promise<Result>) {
    if (name === "wallet_names") entry = callback;
  } } as ToolRegistrar;
  registerReadTools(server, { hintUrl, ...options });
  const original = globalThis.fetch;
  const holdings: string[] = [];
  globalThis.fetch = (async (url: string) => {
    if (!String(url).startsWith(`${hintUrl}/v1/names/by-holder/`)) return new Response("unavailable", { status: 503 });
    holdings.push(String(url));
    return new Response(JSON.stringify({ holder: address, names: [], nextCursor: null, hasMore: false, coverage: { source: "indexed", complete: true, processedLedger: 1, headLedger: 1, gaps: [] } }));
  }) as typeof fetch;
  try { await entry!({ address }); } finally { globalThis.fetch = original; }
  assert.equal(holdings.length, 1, holdings.join(", "));
  return Number(new URL(holdings[0]).searchParams.get("limit"));
}

test("wallet_names' first holdings page obeys the same ceiling, not the SDK's 40 (SM-05)", async () => {
  assert.equal(await walletNamesHoldingsLimit({}), 40, "the local default is unchanged");
  assert.equal(await walletNamesHoldingsLimit({ maxHoldingsPageLimit: 60 }), 40, "above the SDK default nothing changes");
  assert.equal(await walletNamesHoldingsLimit({ maxHoldingsPageLimit: 25 }), 25);
  assert.equal(await walletNamesHoldingsLimit({ maxHoldingsPageLimit: 1 }), 1);
});

test("an invalid ceiling is a configuration error, not a silent 100", () => {
  for (const bad of [0, 101, 2.5, Number.NaN]) assert.throws(() => holdingsTool({ maxHoldingsPageLimit: bad }), /maxHoldingsPageLimit/, String(bad));
});
