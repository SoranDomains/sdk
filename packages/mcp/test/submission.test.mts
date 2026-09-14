import assert from "node:assert/strict";
import test from "node:test";
import { Account, Keypair, Networks, Operation, TransactionBuilder } from "@stellar/stellar-sdk";
import { ApiHttpError } from "../src/http.js";
import { submitWithRecovery } from "../src/submission.js";

const key = Keypair.random();
const transaction = new TransactionBuilder(new Account(key.publicKey(), "0"), { fee: "100", networkPassphrase: Networks.TESTNET })
  .addOperation(Operation.manageData({ name: "recovery-fixture", value: "test" })).setTimeout(60).build();
transaction.sign(key);
const signed = transaction.toXDR(), txHash = Buffer.from(transaction.hash()).toString("hex");

test("ambiguous submissions preserve the exact signed hash and never dispatch twice", async () => {
  const replies = [
    async () => { throw new TypeError("response lost"); },
    async () => { throw new SyntaxError("truncated response"); },
    async () => { throw new ApiHttpError(502, "{}", "unavailable"); },
    async () => { throw new ApiHttpError(408, "{}", "timeout"); },
    async () => ({ ok: true, txHash: "0".repeat(64) }),
    async () => ({ ok: true }),
    async () => ({ ok: false, pending: true }),
  ];
  for (const reply of replies) {
    let sends = 0;
    const result = await submitWithRecovery(signed, Networks.TESTNET, async () => { sends++; return reply(); });
    assert.equal(result.ok, false);
    assert.equal(result.pending, true);
    assert.equal(result.txHash, txHash);
    assert.equal(sends, 1);
  }
});

test("confirmation requires the exact signed hash and explicit refusals remain errors", async () => {
  assert.deepEqual(await submitWithRecovery(signed, Networks.TESTNET, async () => ({ ok: true, txHash })),
    { ok: true, txHash, registrarId: undefined });
  for (const status of [400, 403, 409]) {
    await assert.rejects(submitWithRecovery(signed, Networks.TESTNET, async () => { throw new ApiHttpError(status, "{}", "refused"); }),
      error => error instanceof ApiHttpError && error.status === status && (error as any).txHash === txHash && (error as any).kind === "rejected");
  }
  const expired = new ApiHttpError(401, "{}", "expired");
  await assert.rejects(submitWithRecovery(signed, Networks.TESTNET, async () => { throw expired; }), error => error === expired);
  assert.equal("txHash" in expired, false);
});
