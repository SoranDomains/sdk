import assert from "node:assert/strict";
import test from "node:test";
import { Keypair } from "@stellar/stellar-sdk";
import { registerReadTools, registerWriteTools, normalizeHintUrl, rpcServerOptions, toolAnnotations } from "../src/tools.js";
import { boundedJson, isSecureApiUrl } from "../src/http.js";

const payload = (result: any) => JSON.parse(result.content[0].text);
function plain() {
  const handlers = new Map<string, (args: any) => Promise<any>>();
  return { handlers, server: { tool(name: string, _d: string, _s: unknown, handler: any) { handlers.set(name, handler); } } };
}
async function withFetch<T>(impl: typeof fetch, run: () => Promise<T>): Promise<T> {
  const saved = globalThis.fetch;
  globalThis.fetch = impl;
  try { return await run(); } finally { globalThis.fetch = saved; }
}

test("hintUrl is normalised once: trailing slashes stripped, empty means default", async () => {
  assert.equal(normalizeHintUrl("https://x.example///"), "https://x.example");
  assert.equal(normalizeHintUrl(""), "https://api.soran.domains");
  assert.equal(normalizeHintUrl("  "), "https://api.soran.domains");
  assert.equal(normalizeHintUrl(undefined), "https://api.soran.domains");
  const urls: string[] = [];
  const f = plain();
  registerReadTools(f.server as never, { hintUrl: "https://x.example//" });
  await withFetch((async (url: string) => { urls.push(String(url)); return new Response("{}"); }) as never, async () => {
    const out = payload(await f.handlers.get("network_status")!({}));
    assert.match(out._note, /untrusted|third parties|DATA/i);
  });
  assert.deepEqual(urls, ["https://x.example/v1/status", "https://x.example/v1/stats"]);
});

test("http RPC is allowed only for local nodes", () => {
  assert.equal(rpcServerOptions("http://localhost:8000/rpc").allowHttp, true);
  assert.equal(rpcServerOptions("http://127.0.0.1:8000").allowHttp, true);
  assert.equal(rpcServerOptions("http://evil.example").allowHttp, false);
  assert.equal(rpcServerOptions("https://soroban-testnet.stellar.org").allowHttp, false);
});

test("boundedJson stops reading at the byte cap instead of buffering the body", async () => {
  let pulled = 0, cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) { pulled++; controller.enqueue(new Uint8Array(65_536)); },
    cancel() { cancelled = true; },
  });
  await withFetch((async () => new Response(body)) as never, async () => {
    await assert.rejects(boundedJson("https://api.example/v1/big"), /too large/);
  });
  assert.ok(cancelled);
  assert.ok(pulled < 10, `read ${pulled} chunks`);
});

test("boundedJson clips hostile API error detail and ignores non-string detail", async () => {
  await withFetch((async () => new Response(JSON.stringify({ detail: "x".repeat(5000) }), { status: 500 })) as never, async () => {
    await assert.rejects(boundedJson("https://api.example/v1/x"), (e: Error) => e.message.length < 400);
  });
  await withFetch((async () => new Response(JSON.stringify({ detail: { a: "b".repeat(5000) } }), { status: 500 })) as never, async () => {
    await assert.rejects(boundedJson("https://api.example/v1/x"), (e: Error) => e.message.length < 400);
  });
});

test("list_allocations clips non-string and nested fields", async () => {
  const f = plain();
  registerReadTools(f.server as never, { hintUrl: "https://x.example" });
  const huge = "z".repeat(5000);
  await withFetch((async () => new Response(JSON.stringify({ ledger: 1, pending: [{ namespace: "a", evidence: { note: huge }, objections: "y".repeat(9000), extra: [huge, huge, huge, huge, huge, huge, huge] }], objected: [], hasMore: false, nextCursor: null }))) as never, async () => {
    const out = payload(await f.handlers.get("list_allocations")!({ limit: 50 }));
    const item = out.pending[0];
    assert.ok(item.evidence.note.length <= 200);
    assert.ok(item.objections.length <= 200);
    assert.equal(item.extra.length, 5);
    assert.ok(item.extra.every((x: string) => x.length <= 200));
  });
});

test("annotations: reads are readOnly; writes are flagged and high-impact ones destructive", () => {
  assert.equal(toolAnnotations("lookup_name").readOnlyHint, true);
  assert.equal(toolAnnotations("my_wallet").readOnlyHint, true);
  for (const name of ["reclaim_name", "set_resolver", "set_treasury", "transfer_namespace", "make_permanent"]) {
    const a = toolAnnotations(name);
    assert.equal(a.readOnlyHint, false); assert.equal(a.destructiveHint, true);
  }
  // Value-moving and ownership-changing writes are destructive too (claim_namespace escrows the claim fee); only additive upkeep is not.
  for (const name of ["claim_namespace", "claim_username", "issue_name", "issue_batch", "accept_namespace_transfer", "set_payment"]) assert.equal(toolAnnotations(name).destructiveHint, true, name);
  for (const name of ["renew_name", "renew_held_name", "create_wallet"]) assert.equal(toolAnnotations(name).destructiveHint, false, name);
});

test("a server exposing registerTool receives annotations for every tool", async () => {
  const seen = new Map<string, any>();
  const server = { registerTool(name: string, config: any) { seen.set(name, config.annotations); } };
  registerReadTools(server as never, {});
  await registerWriteTools(server as never, { secret: Keypair.random().secret() });
  assert.equal(seen.get("lookup_name").readOnlyHint, true);
  assert.equal(seen.get("reclaim_name").destructiveHint, true);
  for (const [name, annotations] of seen) assert.equal(typeof annotations?.readOnlyHint, "boolean", name);
});

test("high-impact owner writes refuse without an explicit confirm and never reach the owner client", async () => {
  const f = plain();
  await registerWriteTools(f.server as never, { secret: Keypair.random().secret() });
  const other = Keypair.random().publicKey();
  const calls: Array<[string, Record<string, unknown>]> = [
    ["reclaim_name", { namespace: "nova", label: "alice" }],
    ["set_resolver", { namespace: "nova", resolver: null }],
    ["set_treasury", { namespace: "nova", treasury: other }],
    ["transfer_namespace", { namespace: "nova", to: other }],
  ];
  await withFetch((async () => { throw new Error("no network expected"); }) as never, async () => {
    for (const [name, args] of calls) {
      for (const confirm of [undefined, "yes", ""]) {
        const result = await f.handlers.get(name)!({ ...args, confirm });
        assert.equal(result.isError, true, name);
        assert.match(payload(result).message, /refusing.*confirm/i, name);
      }
    }
  });
});

test("the API base must be https, or plain http only to a local host (SM-06)", () => {
  for (const url of ["https://api.soran.domains", "https://api.example:8443/base", "http://localhost:8787", "http://127.0.0.1:8787/", "http://127.0.0.1", "http://[::1]:8787"])
    assert.equal(normalizeHintUrl(url), url.replace(/\/+$/, ""), url);
  for (const url of ["http://api.example", "http://api.soran.domains", "http://localhost.evil.example", "http://127.0.0.1.evil.example", "http://127.0.0.1@evil.example/",
    "http://localhost:80@evil.example", "http://evil.example#@localhost/", "HTTP://evil.example", "ftp://api.example", "ws://localhost:8787", "api.example", "//api.example", "javascript:alert(1)", "file:///etc/passwd"])
    assert.throws(() => normalizeHintUrl(url), /SORAN_HINT_URL must use https/, url);
});

test("tools refuse to start with an insecure API base instead of sending the session token to it (SM-06)", async () => {
  const f = plain();
  assert.throws(() => registerReadTools(f.server as never, { hintUrl: "http://evil.example" }), /SORAN_HINT_URL must use https/);
  await assert.rejects(registerWriteTools(f.server as never, { secret: Keypair.random().secret(), hintUrl: "http://evil.example" }), /SORAN_HINT_URL must use https/);
});

test("boundedJson never attaches a token or a request body to plain http off the local host (SM-06)", async () => {
  let sent = 0;
  const fetchStub = (async () => { sent++; return new Response("{}"); }) as never;
  await withFetch(fetchStub, async () => {
    await assert.rejects(boundedJson("http://evil.example/console/x", { a: 1 }, "session-token"), /refusing to send/);
    await assert.rejects(boundedJson("http://evil.example/auth/wallet/verify", { signedXdr: "x" }), /refusing to send/);
    await assert.rejects(boundedJson("http://evil.example/v1/x", undefined, "session-token"), /refusing to send/);
    assert.equal(sent, 0);
    await boundedJson("http://evil.example/v1/public");          // an unauthenticated GET carries nothing secret
    await boundedJson("http://127.0.0.1:8787/console/x", { a: 1 }, "session-token");
    await boundedJson("https://api.example/console/x", { a: 1 }, "session-token");
    assert.equal(sent, 3);
  });
});

// A placeholder, not a real credential: the point is that no spelling of it may come back out.
const SECRET = "hunter2-SECRET";
const CREDENTIALED = [
  `https://svc-user:${SECRET}@api.example`, `https://${SECRET}@api.example`, `https://:${SECRET}@api.example`,
  `https://svc-user:${SECRET}@api.example:8443/base`, `https://svc-user:p%40${SECRET}@api.example/`, `https://svc-user:a@${SECRET}@api.example`,
  `https://svc-user:${SECRET}@`, `https://svc\tuser:${SECRET}@api.example`,
  `http://svc-user:${SECRET}@localhost:8787`, `http://svc-user:${SECRET}@127.0.0.1`, `http://svc-user:${SECRET}@[::1]:8787`,
];

test("an API base with a username or password is refused, whatever its spelling, without echoing it", () => {
  for (const url of CREDENTIALED) {
    assert.equal(isSecureApiUrl(url), false, url);
    assert.throws(() => normalizeHintUrl(url), (error: Error) => /no username or password/.test(error.message) && !error.message.includes(SECRET), url);
  }
  // Nothing else changes: local http and ordinary https still pass, and an @ outside the authority is not a credential.
  for (const url of ["http://localhost:8787", "http://127.0.0.1:8787/", "http://[::1]:8787", "https://api.example/@scope", "https://api.example/base?owner=a@b.example"])
    assert.equal(normalizeHintUrl(url), url.replace(/\/+$/, ""), url);
});

test("tools are never registered with a credentialed API base, so no tool can echo it", async () => {
  for (const url of CREDENTIALED) {
    const read = plain();
    assert.throws(() => registerReadTools(read.server as never, { hintUrl: url }), (error: Error) => /no username or password/.test(error.message) && !error.message.includes(SECRET), url);
    assert.equal(read.handlers.size, 0, "no read tool was registered");
    const write = plain();
    await assert.rejects(registerWriteTools(write.server as never, { secret: Keypair.random().secret(), hintUrl: url }),
      (error: Error) => /no username or password/.test(error.message) && !error.message.includes(SECRET), url);
    assert.equal(write.handlers.size, 0, "no write tool was registered");
  }
});

test("boundedJson refuses a credentialed URL before fetch, so neither fetch nor any message can echo it", async () => {
  let sent = 0;
  // What Node's fetch does with such a URL: it throws, and its message carries the whole URL.
  const echoing = (async (url: string) => { sent++; throw new TypeError(`Request cannot be constructed from a URL that includes credentials: ${url}`); }) as never;
  await withFetch(echoing, async () => {
    for (const url of CREDENTIALED) {
      for (const args of [[], [{ a: 1 }, "session-token"], [undefined, "session-token"]] as Array<[unknown?, string?]>) {
        await assert.rejects(boundedJson(`${url}/v1/status`, ...args), (error: Error) => /username or password/.test(error.message) && !error.message.includes(SECRET), url);
      }
    }
    assert.equal(sent, 0);
  });
});
