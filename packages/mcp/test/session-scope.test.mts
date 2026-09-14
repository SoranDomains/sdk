import assert from "node:assert/strict";
import test from "node:test";
import { Account, Keypair, Networks, Operation, TransactionBuilder } from "@stellar/stellar-sdk";
import { registerWriteTools } from "../src/tools.js";

// Standalone client regression with in-memory sessions and a disposable key.
// The API double enforces session selection and the namespace intent header.
const policy = { default_term_secs: "0", reclaimable: true, trade_fee_bps: 0, tradeable: false, transferable: false };
const activation = { namespace: "liberty", policy, maxNetworkFeeStroops: "50000000" };
const payload = (result: any) => JSON.parse(result.content[0].text);
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function fixture(initialNamespace: string, options: {
  expirePrepare?: boolean;
  afterSelection?: (namespace: string) => Promise<void>;
} = {}) {
  const key = Keypair.random();
  const challenge = new TransactionBuilder(new Account(key.publicKey(), "0"), { fee: "100", networkPassphrase: Networks.TESTNET })
    .addOperation(Operation.manageData({ name: "soran.domains auth", value: "fixture" })).setTimeout(300).build();
  const sessions = new Map<string, string>();
  const trace: { path: string; token: string; namespace?: string; expected: string | null }[] = [];
  const preparedPolicies: unknown[] = [];
  const handlers = new Map<string, (args: any) => Promise<any>>();
  const original = globalThis.fetch;
  let logins = 0, expired = false;
  globalThis.fetch = async (url, init) => {
    const path = new URL(String(url)).pathname;
    const body = JSON.parse(String(init?.body ?? "{}"));
    const headers = new Headers(init?.headers);
    const token = headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
    const expected = headers.get("X-Soran-Namespace");
    if (path === "/auth/wallet/challenge") return Response.json({ challengeId: "fixture", xdr: challenge.toXDR(), network: Networks.TESTNET });
    if (path === "/auth/wallet/verify") {
      const token = `fixture-${++logins}`;
      sessions.set(token, initialNamespace);
      return Response.json({ token });
    }
    trace.push({ path, token, namespace: body.namespace, expected });
    if (!sessions.has(token)) return Response.json({ error: "invalid_or_expired_session" }, { status: 401 });
    if (path === "/console/session/namespace") {
      if (!["liberty", "alpha"].includes(body.namespace)) return Response.json({ error: "no_role_on_namespace" }, { status: 403 });
      sessions.set(token, body.namespace);
      await options.afterSelection?.(body.namespace);
      return Response.json({ ok: true, namespace: body.namespace });
    }
    if (!expected) return Response.json({ error: "namespace_required" }, { status: 400 });
    if (expected !== sessions.get(token) || expected !== body.namespace) return Response.json({ error: "namespace_changed" }, { status: 409 });
    if (path === "/console/registrar/deploy/prepare") {
      if (options.expirePrepare && !expired) {
        expired = true;
        sessions.delete(token);
        return Response.json({ error: "invalid_or_expired_session" }, { status: 401 });
      }
      preparedPolicies.push(body.policy);
      return Response.json({ pending: true, namespace: body.namespace, vanity: { status: "queued" }, retryAfterMs: 2000 }, { status: 202 });
    }
    if (path === "/console/deployment/vanity/registrar/cancel") return Response.json({ ok: true });
    throw new Error(`Unexpected request; this fixture must never submit: ${path}`);
  };
  try {
    await registerWriteTools({ tool(name: string, _description: string, _schema: unknown, handler: any) { handlers.set(name, handler); } } as never,
      { secret: key.secret(), hintUrl: "https://fixture.invalid" });
  } catch (error) { globalThis.fetch = original; throw error; }
  return { handlers, trace, preparedPolicies, logins: () => logins, restore: () => { globalThis.fetch = original; } };
}

for (const initialNamespace of ["", "alpha"]) {
  test(`activation selects liberty from ${initialNamespace || "an empty session"} and preserves the full policy`, async t => {
    const f = await fixture(initialNamespace); t.after(f.restore);
    const result = await f.handlers.get("activate_namespace")!(activation);
    assert.notEqual(result.isError, true, result.content[0].text);
    assert.equal(payload(result).status, "queued");
    assert.deepEqual(f.trace.map(({ path, namespace, expected }) => ({ path, namespace, expected })), [
      { path: "/console/session/namespace", namespace: "liberty", expected: null },
      { path: "/console/registrar/deploy/prepare", namespace: "liberty", expected: "liberty" },
    ]);
    assert.deepEqual(f.preparedPolicies, [policy]);
  });
}

test("a renewed session selects liberty again before retrying preparation", async t => {
  const f = await fixture("alpha", { expirePrepare: true }); t.after(f.restore);
  const result = await f.handlers.get("activate_namespace")!(activation);
  assert.notEqual(result.isError, true, result.content[0].text);
  assert.equal(f.logins(), 2);
  assert.deepEqual(f.trace.map(({ path, token }) => [path, token]), [
    ["/console/session/namespace", "fixture-1"], ["/console/registrar/deploy/prepare", "fixture-1"],
    ["/console/session/namespace", "fixture-2"], ["/console/registrar/deploy/prepare", "fixture-2"],
  ]);
  assert.deepEqual(f.preparedPolicies, [policy]);
});

test("an unauthorized namespace fails before preparation without a pending transaction", async t => {
  const f = await fixture("alpha"); t.after(f.restore);
  const result = await f.handlers.get("activate_namespace")!({ ...activation, namespace: "other" });
  assert.equal(result.isError, true);
  assert.equal(payload(result).pending, undefined);
  assert.equal(payload(result).txHash, undefined);
  assert.deepEqual(f.trace.map(x => x.path), ["/console/session/namespace"]);
  assert.deepEqual(f.preparedPolicies, []);
});

test("concurrent activation and cancellation cannot move each other's selected namespace", async t => {
  const entered = deferred(), release = deferred();
  const f = await fixture("alpha", { afterSelection: async namespace => {
    if (namespace === "liberty") { entered.resolve(); await release.promise; }
  } });
  t.after(() => { release.resolve(); f.restore(); });
  const activating = f.handlers.get("activate_namespace")!(activation);
  await entered.promise;
  const cancelling = f.handlers.get("cancel_namespace_activation")!({ namespace: "alpha", role: "registrar" });
  release.resolve();
  const results = await Promise.all([activating, cancelling]);
  for (const result of results) assert.notEqual(result.isError, true, result.content[0].text);
  assert.deepEqual(f.trace.map(({ path, namespace }) => [path, namespace]), [
    ["/console/session/namespace", "liberty"], ["/console/registrar/deploy/prepare", "liberty"],
    ["/console/session/namespace", "alpha"], ["/console/deployment/vanity/registrar/cancel", "alpha"],
  ]);
});
