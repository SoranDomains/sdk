import assert from "node:assert/strict";
import test from "node:test";
import { Keypair } from "@stellar/stellar-sdk";
import { registerReadTools, registerWriteTools } from "../src/tools.js";

function fixture() {
  const handlers = new Map<string, (args: any) => Promise<any>>();
  const server = { tool(name: string, _description: string, _schema: any, handler: any) { handlers.set(name, handler); } };
  return { handlers, server };
}
const hintUrl = "http://127.0.0.1:1/fixture";
const payload = (result: any) => JSON.parse(result.content[0].text);

test("allocation tool includes disputes and exposes continuation through every active page", async () => {
  const original = globalThis.fetch;
  const f = fixture();
  registerReadTools(f.server as never, { hintUrl });
  const calls: string[] = [];
  globalThis.fetch = (async url => {
    calls.push(String(url));
    return new Response(JSON.stringify(calls.length === 1
      ? { ledger: 1, pending: [{ namespace: "newer" }], objected: [], hasMore: true, nextCursor: "old-claims" }
      : { ledger: 1, pending: [], objected: [{ namespace: "old-dispute", state: "objected" }], hasMore: false, nextCursor: null }));
  }) as typeof fetch;
  try {
    const first = payload(await f.handlers.get("list_allocations")!({ limit: 50 }));
    assert.equal(first.nextCursor, "old-claims");
    assert.equal(first.truncated, true);
    const second = payload(await f.handlers.get("list_allocations")!({ cursor: first.nextCursor, limit: 50 }));
    assert.equal(second.objected[0].namespace, "old-dispute");
    assert.equal(second.nextCursor, null);
    assert.equal(second.truncated, false);
    assert.match(calls[0], /allocations\?limit=50&includeHistory=false$/);
    assert.match(calls[1], /cursor=old-claims/);
  } finally { globalThis.fetch = original; }
});

test("claim_status reads the exact disputed label rather than a bounded pending queue", async () => {
  const original = globalThis.fetch;
  const f = fixture();
  await registerWriteTools(f.server as never, { secret: Keypair.random().secret(), hintUrl });
  const calls: string[] = [];
  globalThis.fetch = (async url => {
    calls.push(String(url));
    return new Response(JSON.stringify({ ledger: 1, allocation: { namespace: "old-dispute", state: "objected" } }));
  }) as typeof fetch;
  try {
    const result = payload(await f.handlers.get("claim_status")!({ label: "old-dispute" }));
    assert.equal(result.state, "objected");
    assert.deepEqual(calls, [`${hintUrl}/v1/allocations/old-dispute`]);
  } finally { globalThis.fetch = original; }
});
