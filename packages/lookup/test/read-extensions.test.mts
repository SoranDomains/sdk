import assert from "node:assert/strict";
import test from "node:test";
import { StrKey, scValToNative, xdr } from "@stellar/stellar-sdk";
import { DEPLOYMENTS, encodeMuxedAddress, MAX_BATCH_READS, MAX_PRIMARY_BATCH_READS, Soran, SoranError } from "../src/index.js";

const G = StrKey.encodeEd25519PublicKey(new Uint8Array(32).fill(2));
const C = StrKey.encodeContract(new Uint8Array(32).fill(3));
const M = encodeMuxedAddress(G, "18446744073709551615");
const LOOKUP = DEPLOYMENTS.testnet.lookupId;
function fixture(overrides: Record<string, unknown> = {}, options: Record<string, unknown> = {}) {
  const s = new Soran(options), calls: Array<{ id: string; fn: string; args: unknown[] }> = [];
  Object.assign(s, { read: async (id: string, fn: string, args: xdr.ScVal[]) => {
    calls.push({ id, fn, args: args.map(scValToNative) });
    const values: Record<string, unknown> = {
      registry: DEPLOYMENTS.testnet.registryId, version: 2, destination_version: 2,
      name_status_version: 1, batch_read_version: 3, batch_read_limit: MAX_BATCH_READS, primary_batch_limit: MAX_PRIMARY_BATCH_READS,
      name_status: { name: "alice.nova", ledger: 42, timestamp: 77n, state: ["Unregistered"] },
      primary_names: { ledger: 42, timestamp: 77n, results: [["Name", "alice.nova"], ["None"]] },
      reverse_names: { ledger: 42, timestamp: 77n, results: [["Name", "alice.nova"], ["Failed", 10]] },
      primary: DEPLOYMENTS.testnet.primaryId, ...overrides,
    };
    assert.ok(Object.hasOwn(values, fn), "unexpected fallback " + fn);
    if (values[fn] instanceof Error) throw values[fn];
    return values[fn];
  } });
  return { s, calls };
}
const errorCode = (expected: string) => (error: unknown) => error instanceof SoranError && error.code === expected;
for (const [tag, kind] of [["NamespaceMissing", "namespaceMissing"], ["RegistrarMissing", "registrarMissing"], ["Unregistered", "unregistered"]]) test("status " + tag, async () => {
  const { s, calls } = fixture({ name_status: { name: "alice.nova", ledger: 42, timestamp: 77n, state: [tag] } });
  assert.deepEqual(await s.nameStatus("Alice.Nova"), { name: "alice.nova", ledger: 42, timestamp: 77n, state: { kind } });
  assert.deepEqual(calls.at(-1)?.args, ["alice.nova"]);
  assert.ok(calls.every(call => call.id === LOOKUP));
});
for (const [tag, timestamp, expiry] of [["Active", 77n, 77n], ["Expired", 78n, 77n], ["Active", 18446744073709551615n, 0n]] as const) test(`status exact expiry ${tag} at ${timestamp}`, async () => {
  const { s } = fixture();
  const node = await s.node("alice.nova"), record = { registrar: C, node, holder: G, generation: 18446744073709551615n, expires_at: expiry };
  const f = fixture({ name_status: { name: "alice.nova", ledger: 4294967295, timestamp, state: [tag, record] } });
  const result = await f.s.nameStatus("alice.nova");
  assert.equal(result.state.kind, tag.toLowerCase());
  assert.ok("record" in result.state);
  assert.equal(result.state.record.generation, 18446744073709551615n);
  assert.equal(result.state.record.expiresAt, expiry);
  assert.equal(result.state.record.holder, G);
});
test("status rejects malformed metadata and inconsistent clocks", async () => {
  const { s } = fixture(), node = await s.node("alice.nova");
  const record = { registrar: C, node, holder: G, generation: 1n, expires_at: 77n };
  const good = { name: "alice.nova", ledger: 42, timestamp: 77n, state: ["Active", record] };
  const bad = [null, {}, { ...good, name: "bob.nova" }, { ...good, extra: 1 }, { ...good, ledger: 1n }, { ...good, ledger: -1 },
    { ...good, timestamp: 77 }, { ...good, state: ["Active"] }, { ...good, state: ["Unregistered", record] },
    { ...good, state: ["Expired", record] }, { ...good, timestamp: 78n },
    { ...good, state: ["Active", { ...record, node: new Uint8Array(32) }] },
    { ...good, state: ["Active", { ...record, registrar: G }] },
    { ...good, state: ["Active", { ...record, generation: 1 }] },
    { ...good, state: ["Active", { ...record, expires_at: -1n }] },
    { ...good, state: ["Expired", { ...record, expires_at: 0n }] }, { ...good, state: { tag: "Active", values: [record] } }];
  for (const value of bad) await assert.rejects(fixture({ name_status: value }).s.nameStatus("alice.nova"), errorCode("ABI"));
});
test("batch preserves ordered identities, muxed routing IDs and per-row outcomes", async () => {
  const { s, calls } = fixture();
  assert.equal(await s.batchReadLimit(), MAX_BATCH_READS);
  assert.equal(await s.primaryBatchReadLimit(), MAX_PRIMARY_BATCH_READS);
  assert.deepEqual(await s.primaryBatch([G, M]), { ledger: 42, timestamp: 77n, results: [{ address: G, kind: "name", name: "alice.nova" }, { address: M, kind: "none" }] });
  assert.deepEqual(await s.reverseBatch("NOVA", [C, M]), { ledger: 42, timestamp: 77n, results: [{ address: C, kind: "name", name: "alice.nova" }, { address: M, kind: "error", errorCode: 10, errorName: "DependencyUnavailable" }] });
  assert.deepEqual(calls.find(call => call.fn === "primary_names")?.args, [[["Direct", G], ["Muxed", { account: G, id: 18446744073709551615n }]]]);
  assert.deepEqual(calls.find(call => call.fn === "reverse_names")?.args, ["nova", [["Direct", C], ["Muxed", { account: G, id: 18446744073709551615n }]]]);
  assert.ok(calls.every(call => call.id === LOOKUP));
});
test("batch does not deduplicate inputs or manufacture absence from unknown errors", async () => {
  const result = { ledger: 42, timestamp: 77n, results: [["Name", "alice.nova"], ["Failed", 4294967295]] };
  const { s, calls } = fixture({ primary_names: result });
  assert.deepEqual((await s.primaryBatch([G, G])).results, [{ address: G, kind: "name", name: "alice.nova" }, { address: G, kind: "error", errorCode: 4294967295, errorName: null }]);
  assert.deepEqual(calls.at(-1)?.args, [[["Direct", G], ["Direct", G]]]);
});
test("empty batches are observed reads with an empty result", async () => {
  const empty = { ledger: 42, timestamp: 77n, results: [] };
  const { s } = fixture({ primary_names: empty, reverse_names: empty });
  assert.deepEqual(await s.primaryBatch([]), empty);
  assert.deepEqual(await s.reverseBatch("nova", []), empty);
});
test("invalid and oversize inputs fail before any read", async () => {
  for (const input of [null, "G", ["bad"], [" " + G], [7], Array(MAX_BATCH_READS + 1).fill(G)]) {
    const { s, calls } = fixture();
    await assert.rejects(s.primaryBatch(input as string[]), errorCode("INVALID_INPUT"));
    await assert.rejects(s.reverseBatch("nova", input as string[]), errorCode("INVALID_INPUT"));
    assert.equal(calls.length, 0);
  }
});
test("batch rejects malformed, shortened, noncanonical and wrong-namespace output", async () => {
  const good = { ledger: 42, timestamp: 77n, results: [["None"], ["None"]] };
  const cases = [null, {}, { ...good, extra: 1 }, { ...good, results: [] }, { ...good, results: [["None"]] },
    { ...good, ledger: -1 }, { ...good, timestamp: 77 },
    ...[["Unknown"], ["None", 1], ["Name", null], ["Name", "Alice.nova"], ["Name", "alice.other"], ["Name", "a..nova"],
      ["Failed", 0], ["Failed", -1], ["Failed", 1n], ["Failed", 4294967296], ["Failed", 1, 2]].map(value => ({ ...good, results: [value, ["None"]] }))];
  for (const value of cases) await assert.rejects(fixture({ reverse_names: value }).s.reverseBatch("nova", [G, M]), errorCode("ABI"));
});
test("missing capabilities, unsupported limits and wrong anchors never fall back", async () => {
  for (const overrides of [{ version: 1 }, { registry: C }, { batch_read_version: 0 }, { batch_read_version: 1n },
    { batch_read_limit: MAX_BATCH_READS + 1 }, { batch_read_limit: BigInt(MAX_BATCH_READS) }, { batch_read_version: new Error("missing method") }]) {
    const { s, calls } = fixture(overrides);
    await assert.rejects(s.primaryBatch([G, M]));
    await assert.rejects(s.reverseBatch("nova", [G, M]));
    assert.ok(!calls.some(call => ["primary_names", "reverse_names", "primary_of", "name_of"].includes(call.fn)));
  }
  for (const value of [0, 1n, new Error("offline")]) {
    const { s, calls } = fixture({ name_status_version: value });
    await assert.rejects(s.nameStatus("alice.nova"));
    assert.ok(!calls.some(call => call.fn === "name_status"));
  }
});
test("restoration and RPC failures remain errors, never per-row none", async () => {
  for (const error of [new SoranError("archived", "ARCHIVED"), new SoranError("offline", "RPC"), new SoranError("budget exceeded", "SIMULATION")]) {
    const { s } = fixture({ name_status: error, primary_names: error, reverse_names: error });
    await assert.rejects(s.nameStatus("alice.nova"), e => e === error);
    await assert.rejects(s.primaryBatch([G, M]), e => e === error);
    await assert.rejects(s.reverseBatch("nova", [G, M]), e => e === error);
  }
});
test("Primary configuration remains explicit for G/C; M elections are independent", async () => {
  const disabled = fixture({}, { primaryId: null });
  await assert.rejects(disabled.s.primaryBatch([G, M]), errorCode("CONFIG")); assert.equal(disabled.calls.length, 0);
  const onlyM = fixture({ primary_names: { ledger: 42, timestamp: 77n, results: [["None"]] } }, { primaryId: null });
  assert.equal((await onlyM.s.primaryBatch([M])).results[0].kind, "none");
  const wrong = fixture({}, { primaryId: C });
  await assert.rejects(wrong.s.primaryBatch([G, M]), errorCode("CONFIG"));
  assert.ok(!wrong.calls.some(call => call.fn === "primary_names"));
  const direct = fixture({}, { resolutionMode: "direct" });
  await assert.rejects(direct.s.nameStatus("alice.nova"), errorCode("CONFIG"));
  await assert.rejects(direct.s.primaryBatch([G, M]), errorCode("CONFIG"));
});

test("history batches split only leading budget failures and retain per-row observation", async () => {
  for (const method of ["primary_names", "reverse_names"] as const) {
    const { s, calls } = fixture();
    const original = (s as any).read.bind(s);
    let ledger = 100;
    Object.assign(s, { read: async (id: string, fn: string, args: xdr.ScVal[]) => {
      if (fn !== method) return original(id, fn, args);
      const input = args.map(scValToNative), identities = input[method === "reverse_names" ? 1 : 0] as unknown[];
      calls.push({ id, fn, args: input });
      if (identities.length > 1) throw new SoranError(`simulate ${method} on ${id} failed: HostError: Error(Budget, ExceededLimit)`, "SIMULATION");
      return { ledger: ledger++, timestamp: BigInt(ledger), results: [["Name", "alice.nova"]] };
    } });
    const input = [G, M, C, M, G, C];
    const rows = method === "primary_names" ? await s.primaryNames(input, { concurrency: 1 }) : await s.reverseMany("nova", input, { concurrency: 1 });
    assert.deepEqual(rows.map(row => row.address), input);
    assert.deepEqual(rows.map(row => row.ledger), [100, 101, 102, 101, 100, 102]);
    assert.ok(rows.every(row => row.kind === "name"));
    const reads = calls.filter(call => call.fn === method);
    assert.equal(reads.length, 4, "three distinct identities: failed size three, then single reads");
    assert.ok(calls.every(call => call.id === LOOKUP));
  }
});
test("history helper preserves fast batches and validates the whole request first", async () => {
  const { s, calls } = fixture();
  assert.equal((await s.primaryNames([G, M])).length, 2);
  assert.equal(calls.filter(call => call.fn === "primary_names").length, 1);
  for (const values of [Array(257).fill(G), [G, G, G, G, "bad"]]) {
    const { s, calls } = fixture();
    await assert.rejects(s.primaryNames(values), errorCode("INVALID_INPUT")); assert.equal(calls.length, 0);
  }
});
test("history helper does not split restoration, contract or incidental log errors", async () => {
  for (const error of [new SoranError("archived", "ARCHIVED"), new SoranError("offline", "RPC"),
    new SoranError(`simulate primary_names on ${LOOKUP} failed: Error(Contract, #10) log: Error(Budget, ExceededLimit)`, "SIMULATION"),
    new SoranError(`simulate primary_names on ${LOOKUP} failed: other error`, "SIMULATION")]) {
    const { s, calls } = fixture({ primary_names: error });
    await assert.rejects(s.primaryNames([G, M]), e => e === error);
    assert.equal(calls.filter(call => call.fn === "primary_names").length, 1);
  }
  const budget = new SoranError(`simulate primary_names on ${LOOKUP} failed: Error(Budget, ExceededLimit)`, "SIMULATION");
  const { s, calls } = fixture({ primary_names: budget });
  await assert.rejects(s.primaryNames([G]), e => e === budget);
  assert.equal(calls.filter(call => call.fn === "primary_names").length, 1, "single failures do not loop");
});

test("reverse and Primary enforce separate published capacities", async () => {
  const none = (count: number) => ({ ledger: 42, timestamp: 77n, results: Array.from({ length: count }, () => ["None"]) });
  const { s, calls } = fixture({ primary_names: none(MAX_PRIMARY_BATCH_READS), reverse_names: none(MAX_BATCH_READS) });
  assert.equal((await s.reverseBatch("nova", Array(MAX_BATCH_READS).fill(M))).results.length, MAX_BATCH_READS);
  assert.equal((await s.primaryBatch(Array(MAX_PRIMARY_BATCH_READS).fill(G))).results.length, MAX_PRIMARY_BATCH_READS);
  const before = calls.length;
  await assert.rejects(s.primaryBatch(Array(MAX_PRIMARY_BATCH_READS + 1).fill(G)), errorCode("INVALID_INPUT"));
  await assert.rejects(s.reverseBatch("nova", Array(MAX_BATCH_READS + 1).fill(G)), errorCode("INVALID_INPUT"));
  assert.equal(calls.length, before);
});

test("method limits are read from the deployed capability and validated", async () => {
  const older = fixture({ batch_read_version: 1, batch_read_limit: 2 });
  assert.equal(await older.s.batchReadLimit(), 2);
  assert.equal(await older.s.primaryBatchReadLimit(), 2);
  await assert.rejects(older.s.reverseBatch("nova", [G, C, M]), errorCode("INVALID_INPUT"));
  assert.ok(!older.calls.some(call => call.fn === "reverse_names"));
  for (const primary_batch_limit of [0, -1, MAX_PRIMARY_BATCH_READS + 1, 8n, 1.5, null, new Error("missing")]) {
    const { s, calls } = fixture({ primary_batch_limit });
    await assert.rejects(s.primaryBatch([G]));
    assert.ok(!calls.some(call => call.fn === "primary_names"));
  }
  await assert.rejects(fixture({ batch_read_limit: 2, primary_batch_limit: 8 }).s.primaryBatch([G]), errorCode("ABI"));
});

test("history uses advertised capacities and halves only exhausted batches", async () => {
  for (const method of ["primary_names", "reverse_names"] as const) {
    const { s } = fixture();
    const original = (s as any).read.bind(s);
    const sizes: number[] = [];
    let ledger = 10;
    Object.assign(s, { read: async (id: string, fn: string, args: xdr.ScVal[]) => {
      if (fn !== method) return original(id, fn, args);
      const identities = scValToNative(args[method === "primary_names" ? 0 : 1]) as unknown[];
      sizes.push(identities.length);
      if (identities.length > 4) throw new SoranError(`simulate ${method} on ${id} failed: Error(Budget, ExceededLimit)`, "SIMULATION");
      return { ledger: ledger++, timestamp: 77n, results: identities.map(() => ["None"]) };
    } });
    const input = Array.from({ length: 20 }, (_, i) => encodeMuxedAddress(G, String(i)));
    const results = method === "primary_names" ? await s.primaryNames(input, { concurrency: 1 }) : await s.reverseMany("nova", input, { concurrency: 1 });
    assert.deepEqual(results.map(row => row.address), input);
    assert.deepEqual(sizes, method === "primary_names" ? [16, 8, 4, 4, 4, 4, 4] : [20, 10, 5, ...Array(10).fill(2)]);
    assert.deepEqual(results.map(row => row.ledger), Array.from({ length: 20 }, (_, i) => 10 + Math.floor(i / (method === "primary_names" ? 4 : 2))));
  }
});


test("version 2 remains bounded at its qualified 16/8 capacities", async () => {
  const old = fixture({ batch_read_version: 2, batch_read_limit: 16, primary_batch_limit: 8 });
  assert.equal(await old.s.batchReadLimit(), 16);
  assert.equal(await old.s.primaryBatchReadLimit(), 8);
  for (const values of [{ batch_read_limit: 32, primary_batch_limit: 8 }, { batch_read_limit: 16, primary_batch_limit: 16 }]) {
    await assert.rejects(fixture({ batch_read_version: 2, ...values }).s.primaryBatch([G]), errorCode("ABI"));
  }
});

test("history validates concurrency before any RPC calls", async () => {
  for (const concurrency of [0, -1, 5, 1.5, "2", NaN, Infinity]) {
    const { s, calls } = fixture();
    await assert.rejects(s.primaryNames([G], { concurrency } as any), errorCode("INVALID_INPUT"));
    assert.equal(calls.length, 0);
  }
});

test("history overlaps bounded reads and preserves order when replies arrive out of order", async () => {
  const { s } = fixture({ batch_read_limit: 2, primary_batch_limit: 2 });
  const original = (s as any).read.bind(s);
  let active = 0, peak = 0;
  const pending: Array<() => void> = [];
  Object.assign(s, { read: async (id: string, fn: string, args: xdr.ScVal[]) => {
    if (fn !== "primary_names") return original(id, fn, args);
    const count = (scValToNative(args[0]) as unknown[]).length;
    const ledger = 100 + pending.length;
    peak = Math.max(peak, ++active);
    await new Promise<void>(resolve => pending.push(resolve));
    active--;
    return { ledger, timestamp: BigInt(ledger), results: Array.from({ length: count }, () => ["None"]) };
  } });
  const input = [G, M, C, encodeMuxedAddress(G, "0"), M, G];
  const answer = s.primaryNames(input);
  for (let i = 0; i < 30 && pending.length < 2; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(pending.length, 2);
  pending[1]();
  pending[0]();
  const result = await answer;
  assert.equal(peak, 2);
  assert.equal(active, 0);
  assert.deepEqual(result.map(row => row.address), input);
  assert.deepEqual(result.map(row => row.ledger), [100, 100, 101, 101, 100, 100]);
  assert.notEqual(result[0], result[5], "duplicated identities have independent result objects");
});

test("fatal history errors drain active work and prevent new batches", async () => {
  const { s } = fixture({ batch_read_limit: 1, primary_batch_limit: 1 });
  const original = (s as any).read.bind(s);
  const error = new SoranError("archived", "ARCHIVED");
  const pending: Array<{ resolve: (value: unknown) => void; reject: (error: unknown) => void }> = [];
  Object.assign(s, { read: async (id: string, fn: string, args: xdr.ScVal[]) => {
    if (fn !== "primary_names") return original(id, fn, args);
    return new Promise((resolve, reject) => pending.push({ resolve, reject }));
  } });
  const answer = s.primaryNames([G, M, C, encodeMuxedAddress(G, "0")]);
  for (let i = 0; i < 30 && pending.length < 2; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(pending.length, 2);
  pending[0].reject(error);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(pending.length, 2);
  pending[1].resolve({ ledger: 1, timestamp: 1n, results: [["None"]] });
  await assert.rejects(answer, value => value === error);
  assert.equal(pending.length, 2);
});

test("concurrent budget splitting preserves every full muxed identity exactly once", async () => {
  const { s } = fixture();
  const original = (s as any).read.bind(s);
  let active = 0, peak = 0, ledger = 100;
  const succeeded: bigint[] = [];
  Object.assign(s, { read: async (id: string, fn: string, args: xdr.ScVal[]) => {
    if (fn !== "reverse_names") return original(id, fn, args);
    const input = scValToNative(args[1]) as Array<[string, { account: string; id: bigint }]>;
    peak = Math.max(peak, ++active);
    await new Promise(resolve => setImmediate(resolve));
    active--;
    if (input.length > 2) throw new SoranError(`simulate ${fn} on ${id} failed: Error(Budget, ExceededLimit)`, "SIMULATION");
    const observed = ledger++;
    succeeded.push(...input.map(([, route]) => route.id));
    return { ledger: observed, timestamp: BigInt(observed), results: input.map(([, route]) => ["Name", `user${route.id}.nova`]) };
  } });
  const input = Array.from({ length: 100 }, (_, i) => encodeMuxedAddress(G, String(i)));
  const rows = await s.reverseMany("nova", input, { concurrency: 3 });
  assert.equal(peak, 3);
  assert.equal(active, 0);
  assert.equal(succeeded.length, 100);
  assert.equal(new Set(succeeded).size, 100);
  assert.deepEqual(rows.map(row => row.address), input);
  rows.forEach((row, i) => { assert.equal(row.kind, "name"); if (row.kind === "name") assert.equal(row.name, `user${i}.nova`); });
});
