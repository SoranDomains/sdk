import assert from "node:assert/strict";
import test from "node:test";
import { readdirSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import { Soran, SoranError, DEPLOYMENTS } from "../src/index.js";

const C = (n: number) => StrKey.encodeContract(Buffer.alloc(32, n));
const LOOKUP = C(61), REGISTRAR = C(62);
const G = Keypair.random().publicKey();
const HINT = "https://hint.example";
const hasher = new Soran({ resolutionMode: "direct" });
const nameNode = await hasher.node("alice.nova");
const meta = () => ({ name: "alice.nova", node: nameNode, registrar: REGISTRAR, holder: G, builtin_address: G,
  generation: 18446744073709551615n, expires_at: 0n, active: true, no_expiry: true, namespace_permanent: true });
const coverage = { source: "indexed", complete: true, processedLedger: 10, headLedger: 10, gaps: [] };
const json = (body: unknown, init?: ResponseInit) => new Response(JSON.stringify(body), init);

/** A fetch with the one relevant workerd behaviour: `redirect: "error"` is not implemented and throws. */
function workerdFetch(routes: (url: URL) => Response | Promise<Response>, seen: Array<{ url: string; redirect: unknown }> = []): typeof fetch {
  return (async (input: unknown, init?: RequestInit) => {
    if (init?.redirect === "error")
      throw new TypeError('Invalid redirect value, must be one of "follow" or "manual" ("error" won\'t be implemented since it does not make sense at the edge; use "manual" and check the response status code).');
    seen.push({ url: String(input), redirect: init?.redirect });
    return routes(new URL(String(input)));
  }) as typeof fetch;
}
async function withFetch<T>(impl: typeof fetch, run: () => Promise<T>): Promise<T> {
  const saved = globalThis.fetch;
  globalThis.fetch = impl;
  try { return await run(); } finally { globalThis.fetch = saved; }
}
function client(options: Record<string, unknown> = {}) {
  const s = new Soran({ lookupId: LOOKUP, hintUrl: HINT, ...options });
  Object.assign(s, { read: async (_id: string, fn: string) => {
    if (fn === "registry") return DEPLOYMENTS.testnet.registryId;
    if (fn === "version") return 1;
    if (fn === "name_metadata") return meta();
    throw new Error(`unexpected ${fn}`);
  } });
  return s;
}
const hintNamespaces = (s: Soran) => (s as unknown as { namespaceHint(): Promise<string[]> }).namespaceHint();

test("hint fetches work on a runtime that rejects redirect:error (workerd) and pin redirect:manual", async () => {
  const seen: Array<{ url: string; redirect: unknown }> = [];
  const routes = (url: URL) => {
    if (url.pathname === "/v1/showcase") return json({ namespaces: [{ label: "nova" }, { label: "liberty" }] });
    if (url.pathname === "/v1/names/nova/alice/history") return json({ issuedAt: "t", issuedLedger: 3, events: [{ action: "issued", ledger: 3, txHash: "ab", at: "t" }] });
    if (url.pathname === `/v1/names/by-holder/${G}`) return json({ holder: G, names: [{ name: "alice.nova" }], nextCursor: null, hasMore: false, coverage });
    return json({ error: "not_found" }, { status: 404 });
  };
  await withFetch(workerdFetch(routes, seen), async () => {
    const s = client();
    assert.deepEqual(await hintNamespaces(s), ["nova", "liberty"]);
    assert.equal((await s.history("alice.nova")).events.length, 1);
    const page = await s.namesOfPage(G);
    assert.equal(page.names.length, 1); assert.equal(page.verification.failed, 0);
  });
  assert.equal(seen.length, 3);
  assert.ok(seen.every(request => request.redirect === "manual"), JSON.stringify(seen));
});

test("a 3xx from the hint host is a refused redirect, never followed, on the real fetch", async () => {
  let landed = 0;
  const target = createServer((_req, res) => { landed++; res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ namespaces: ["evil"] })); });
  const origin = createServer((_req, res) => { res.writeHead(302, { location: `http://127.0.0.1:${(target.address() as AddressInfo).port}/v1/showcase` }); res.end(); });
  const listen = (server: Server) => new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  await Promise.all([listen(target), listen(origin)]);
  try {
    const s = new Soran({ lookupId: LOOKUP, hintUrl: `http://127.0.0.1:${(origin.address() as AddressInfo).port}` });
    assert.deepEqual(await hintNamespaces(s), []);
    await assert.rejects(s.history("alice.nova"), (e: unknown) => e instanceof SoranError && e.code === "RPC" && /redirect refused/.test(e.message));
    await assert.rejects(s.namesOfPage(G), (e: unknown) => e instanceof SoranError && /redirect refused/.test(e.message));
    assert.equal(landed, 0, "the redirect target must never be requested");
  } finally { origin.close(); target.close(); }
});

test("redirect and non-2xx statuses from a stubbed fetch, including a browser opaque redirect, are failures", async () => {
  const responses: Array<[string, () => unknown, RegExp]> = [
    ["301", () => new Response(null, { status: 301, headers: { location: "https://evil.example/" } }), /redirect refused/],
    ["308", () => new Response(null, { status: 308, headers: { location: "https://evil.example/" } }), /redirect refused/],
    ["opaque redirect", () => ({ ok: false, status: 0, type: "opaqueredirect", headers: new Headers(), body: null }), /redirect refused/],
    ["404", () => json({ error: "name_not_found" }, { status: 404 }), /HTTP 404/],
    ["500", () => new Response("boom", { status: 500 }), /HTTP 500/],
  ];
  for (const [label, response, message] of responses) {
    await withFetch((async () => response()) as unknown as typeof fetch, async () => {
      const s = client();
      assert.deepEqual(await hintNamespaces(s), [], label);
      await assert.rejects(s.history("alice.nova"), (e: unknown) => e instanceof SoranError && message.test(e.message), label);
    });
  }
});

test("transport failures keep their reason instead of a generic outage", async () => {
  await withFetch((async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch, async () => {
    await assert.rejects(client().history("alice.nova"), (e: unknown) => e instanceof SoranError && /request failed: fetch failed/.test(e.message));
    await assert.rejects(client().namesOfPage(G), (e: unknown) => e instanceof SoranError && /holdings discovery unavailable.*request failed: fetch failed/.test(e.message));
  });
  await withFetch((async () => new Response("<html>", { status: 200 })) as unknown as typeof fetch, async () => {
    await assert.rejects(client().history("alice.nova"), (e: unknown) => e instanceof SoranError && /invalid JSON/.test(e.message));
  });
});

/** Worker-executed sources: the hosted MCP bundles lookup, and workerd throws on this option. */
test("no worker-executed source requests redirect:error", () => {
  const dir = fileURLToPath(new URL("../src/", import.meta.url));
  const offenders = readdirSync(dir).filter(file => file.endsWith(".ts"))
    .filter(file => /redirect\s*:\s*["'`]error["'`]/.test(readFileSync(dir + file, "utf8")));
  assert.deepEqual(offenders, []);
});

/** The real API embeds `coverage` (first 100 gaps, every enrolled contract) in each page: 27.9 KiB for 4 events in production. */
const bigCoverage = (contracts: number) => ({ source: "indexed", complete: false, processedLedger: 10, headLedger: 12,
  gaps: Array.from({ length: 100 }, (_, i) => ({ contractId: C(i % 200), fromLedger: 1000 + i, toLedger: 2000 + i, reason: "retention_gap", detectedAt: "2026-09-29T12:00:00.000Z", note: "n".repeat(60) })),
  contracts: Array.from({ length: contracts }, (_, i) => ({ contractId: C(i % 200), role: "registrar", namespace: `ns${i}`, enrolledLedger: 1, detail: "d".repeat(70) })) });
const historyBody = (events: number, contracts = 16) => ({ name: "alice.nova", issuedAt: "2026-01-01T00:00:00Z", issuedLedger: 3,
  events: Array.from({ length: events }, (_, i) => ({ action: "text_set", ledger: 10 + i, txHash: "ab".repeat(32), at: "2026-01-01T00:00:00Z", ingestedAt: "2026-01-01T00:00:01Z",
    eventId: `000000${i}-0000000001`, contractId: C(7), detail: { key: "description", note: "x".repeat(150) } })),
  nextCursor: null, hasMore: false, truncated: false, coverage: bigCoverage(contracts) });

test("history() survives an API page that carries the full coverage envelope (SM-03)", async () => {
  const sizes: number[] = [];
  for (const events of [4, 16, 100]) {
    const body = JSON.stringify(historyBody(events));
    sizes.push(body.length);
    await withFetch((async () => new Response(body)) as unknown as typeof fetch, async () => {
      assert.equal((await client().history("alice.nova")).events.length, events);
    });
  }
  assert.ok(sizes[0] > 25_000 && sizes[1] > 32_768 && sizes[2] < 131_072, `unrealistic fixture sizes ${sizes}`);
});

test("history() over the response cap fails with a clear response-too-large error, not an outage", async () => {
  const body = JSON.stringify(historyBody(100, 900));
  assert.ok(body.length > 131_072);
  await withFetch((async () => new Response(body)) as unknown as typeof fetch, async () => {
    await assert.rejects(client().history("alice.nova"), (e: unknown) => e instanceof SoranError && e.code === "RPC" && /response too large/.test(e.message) && !/outage/.test(e.message));
  });
  // The same holds when the length is only discovered while streaming.
  await withFetch((async () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(body)); c.close(); } }))) as unknown as typeof fetch, async () => {
    await assert.rejects(client().history("alice.nova"), /response too large/);
  });
});

test("the namespace hint asks for a logo-free showcase so an uploaded logo cannot exceed the 4 KiB cap (SM-04)", async () => {
  const logo = `data:image/png;base64,${"A".repeat(6_000)}`;
  const namespaces = (withLogo: boolean) => [{ label: "nova", displayName: "Nova", policy: "reclaimable", logo: withLogo ? logo : null, names: 3 }, { label: "liberty", displayName: "Liberty", policy: "reclaimable", logo: null, names: 1 }];
  const urls: string[] = [];
  const api = (async (input: unknown) => {
    const url = new URL(String(input)); urls.push(url.pathname + url.search);
    return json({ namespaces: namespaces(url.searchParams.get("logos") !== "0") });
  }) as unknown as typeof fetch;
  await withFetch(api, async () => {
    assert.deepEqual(await hintNamespaces(client()), ["nova", "liberty"]);
    const s = client({ primaryId: null });
    Object.assign(s, { read: async (_id: string, fn: string) => fn === "registry" ? DEPLOYMENTS.testnet.registryId : fn === "version" ? 1 : fn === "reverse" ? "alice.nova" : (() => { throw new Error(`unexpected ${fn}`); })() });
    assert.equal(await s.reverseLookup(G), "alice.nova");
  });
  assert.ok(urls.length === 2 && urls.every(url => url === "/v1/showcase?logos=0"), JSON.stringify(urls));
});

test("a hint URL that carries credentials never leaks them through the failure reason (SM-01)", async () => {
  // Node's fetch refuses such a URL and echoes it, password included, in its TypeError: the reason reaches MCP clients and their models.
  const s = client({ hintUrl: "https://alice:hunter2@hint.example" });
  for (const call of [() => s.history("alice.nova"), () => s.namesOfPage(G)]) {
    const error = await call().then(() => undefined, (e: unknown) => e);
    assert.ok(error instanceof SoranError, "the failure is reported, not swallowed");
    assert.match(error.message, /request failed/);
    assert.doesNotMatch(error.message, /hunter2|alice:/);
    assert.match(error.message, /\*\*\*@hint\.example/);
  }
});

test("a credential with an @, /, ?, #, space or percent-encoding in it is redacted whole, not just up to its first @ (SM-01)", async () => {
  // Real Node fetch echoes the raw input, so none of these can be delimited by a pattern: the configured URL itself is the boundary.
  for (const password of ["p@ss-secretTAIL", "pa/ss-secretTAIL", "pa ss-secretTAIL", "pa?ss-secretTAIL", "pa#ss-secretTAIL", "p%40ss-secretTAIL", "a@b@c-secretTAIL"]) {
    const s = client({ hintUrl: `https://uzr9:${password}@hint.example` });
    for (const call of [() => s.history("alice.nova"), () => s.namesOfPage(G)]) {
      const error = await call().then(() => undefined, (e: unknown) => e);
      assert.ok(error instanceof SoranError, `${password}: the failure is reported, not swallowed`);
      assert.match(error.message, /request failed/, password);
      assert.doesNotMatch(error.message, /secretTAIL|uzr9|@ss|pa\/|pa\?|pa#|a@b/, `${password}: ${error.message}`);
      assert.match(error.message, /\*\*\*@hint\.example/, password);
    }
  }
  // A user-only credential (a token in the userinfo) is a credential too.
  const token = client({ hintUrl: "https://tok-secretTAIL@hint.example" });
  const tokenError = await token.history("alice.nova").then(() => undefined, (e: unknown) => e);
  assert.ok(tokenError instanceof SoranError);
  assert.doesNotMatch(tokenError.message, /secretTAIL/);
});

test("a runtime that re-serialises the URL in its error is still redacted to the last @ (SM-01)", async () => {
  // Not the configured spelling (a runtime may decode or normalise it), so only the pattern can catch it.
  for (const echoed of ["https://alice:p@ss-secretTAIL@hint.example", "https://alice:p%40ss-secretTAIL@hint.example", "https://alice:pa/ss-secretTAIL@hint.example"]) {
    await withFetch((async () => { throw new TypeError(`Fetch API cannot load: ${echoed}/v1/names/nova/alice/history`); }) as unknown as typeof fetch, async () => {
      const error = await client({ hintUrl: "https://other:configured@hint.example" }).history("alice.nova").then(() => undefined, (e: unknown) => e);
      assert.ok(error instanceof SoranError);
      assert.doesNotMatch(error.message, /secretTAIL|alice:|%40ss|@ss/, echoed);
      assert.match(error.message, /https:\/\/\*\*\*@hint\.example\/v1\/names/, echoed);
    });
  }
});

test("ordinary failure reasons are untouched by the credential redaction", async () => {
  await withFetch((async () => { throw new TypeError("fetch failed: connect ECONNREFUSED 127.0.0.1:1"); }) as unknown as typeof fetch, async () => {
    const error = await client().history("alice.nova").then(() => undefined, (e: unknown) => e);
    assert.ok(error instanceof SoranError);
    assert.match(error.message, /request failed: TypeError: fetch failed: connect ECONNREFUSED 127\.0\.0\.1:1|request failed: fetch failed: connect ECONNREFUSED 127\.0\.0\.1:1/);
  });
});

// A stream may never settle cancellation. Reject before cleanup finishes, then
// release the test stream so this regression does not leave a pending read.
for (const kind of ["redirect", "oversize"] as const) {
  test(`hint ${kind} rejection does not wait for stream cancellation`, async () => {
    let release!: () => void;
    let cancelled = false;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        if (kind === "oversize") controller.enqueue(new Uint8Array(131_073));
      },
      cancel() { cancelled = true; return pending; },
    });
    const response = new Response(body, { status: kind === "redirect" ? 302 : 200 });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await withFetch((async () => response) as typeof fetch, async () => {
        const result = await Promise.race([
          client().history("alice.nova").then(() => "unexpected success", error => String(error)),
          new Promise<string>(resolve => { timer = setTimeout(() => resolve("cancellation blocked rejection"), 500); }),
        ]);
        assert.match(result, kind === "redirect" ? /redirect refused/ : /response too large/);
        assert.equal(cancelled, true);
      });
    } finally {
      clearTimeout(timer);
      release();
    }
  });
}
