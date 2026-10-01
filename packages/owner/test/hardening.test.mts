import assert from "node:assert/strict";
import test from "node:test";
import { Account, Address, Keypair, SorobanDataBuilder, StrKey, TransactionBuilder, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { SoranOwner, OwnerError } from "../src/index.js";
import { FundingServiceClient } from "../src/funding-service.js";
import { FundingError } from "../src/funding-types.js";

const kp = Keypair.random(), G = kp.publicKey();
const RESOLVER = StrKey.encodeContract(Buffer.alloc(32, 9));
const nodeArg = xdr.ScVal.scvBytes(Buffer.alloc(32, 1));

function auth(fn: string, args: xdr.ScVal[]) {
  const call = new xdr.InvokeContractArgs({ contractAddress: new Address(RESOLVER).toScAddress(), functionName: fn, args });
  const root = new xdr.SorobanAuthorizedInvocation({ function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(call), subInvocations: [] });
  return new xdr.SorobanAuthorizationEntry({ credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(), rootInvocation: root });
}

/** Holder whose transport is fully mocked; `sends` scripts each sendTransaction result. */
function mocked(sends: Array<Record<string, unknown>>) {
  const counts = { signed: 0, sent: 0 };
  const holder = new SoranOwner({ signer: { publicKey: () => G, signTransaction: async (encoded, { networkPassphrase }) => {
    counts.signed++;
    const tx = TransactionBuilder.fromXDR(encoded, networkPassphrase) as any;
    tx.sign(kp);
    return tx.toXDR();
  } } });
  Object.assign(holder, {
    server: {
      getAccount: async () => new Account(G, "0"),
      simulateTransaction: async (tx: any) => {
        const op = tx.operations[0].func.invokeContract;
        return { _parsed: true, transactionData: new SorobanDataBuilder(), minResourceFee: "0",
          result: { auth: [auth(op.functionName.toString(), op.args)], retval: xdr.ScVal.scvVoid() }, events: [], latestLedger: 1 };
      },
      sendTransaction: async () => { const next = sends[counts.sent++]; assert.ok(next, "unexpected extra send"); return next; },
    },
    confirm: async () => ({ ledger: 2, returnValue: null }),
  });
  return { holder, counts };
}
const call = (h: unknown) => (h as any).invoke(RESOLVER, "set_text", [nodeArg, new Address(G).toScVal()], {}) as Promise<{ ledger: number }>;
const badSeq = { status: "ERROR", errorResult: xdr.TransactionResult.fromXDR("AAAAAAAAAGT////7AAAAAA==", "base64") };

test("a submit rejected with txBadSeq (nothing included) is retried once with a fresh sequence", async () => {
  assert.equal((badSeq.errorResult as any).result.type, "txBadSeq");
  const { holder, counts } = mocked([badSeq, { status: "PENDING" }]);
  const r = await call(holder);
  assert.equal(r.ledger, 2);
  assert.equal(counts.sent, 2);
});

test("bad-seq is retried at most once", async () => {
  const { holder, counts } = mocked([badSeq, badSeq]);
  await assert.rejects(call(holder), /submit rejected/);
  assert.equal(counts.sent, 2);
});

test("a PENDING/accepted tx that later fails confirmation is never re-sent; other rejections are not retried", async () => {
  const other = { status: "ERROR", errorResult: xdr.TransactionResult.fromXDR("AAAAAAAAAGT////+AAAAAA==", "base64") };
  const { holder, counts } = mocked([other]);
  await assert.rejects(call(holder), (e: unknown) => e instanceof OwnerError && !!e.txHash);
  assert.equal(counts.sent, 1);

  const pending = mocked([{ status: "PENDING" }, { status: "PENDING" }]);
  Object.assign(pending.holder, { confirm: async () => { throw new OwnerError("bad_seq in confirm text txBadSeq", null, "set_text", null, null, "ab"); } });
  await assert.rejects(call(pending.holder));
  assert.equal(pending.counts.sent, 1);
});

test("funding service turns a non-JSON gateway body into FundingError, not SyntaxError", async () => {
  const service = new FundingServiceClient("https://sponsor.invalid", {} as any, async () => new Response("<html>502</html>", { status: 502 }));
  const quote = { quoteId: "a".repeat(64) } as any;
  await assert.rejects(service.status(quote), (e: unknown) => e instanceof FundingError && e.kind === "unavailable");
  await assert.rejects(service.submit(quote, "AAAA"), (e: unknown) => e instanceof FundingError && e.kind === "pending");
});
