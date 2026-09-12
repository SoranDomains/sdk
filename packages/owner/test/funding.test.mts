import assert from "node:assert/strict";
import test from "node:test";
import {
  Account,
  Address,
  Keypair,
  Networks,
  Operation,
  StrKey,
  TransactionBuilder,
  authorizeEntry,
  xdr,
} from "@stellar/stellar-sdk";
import {
  sponsorPlan,
  validateSponsorTransaction,
  replaceSponsorAuth,
} from "../src/funding-user.js";
import {
  encodeSponsorQuote,
  decodeSponsorQuote,
  sponsorIntentHash,
  sponsorPolicyToScVal,
  sponsorActorFromNative,
} from "../src/funding-types.js";
import { authorizedInvocation } from "../src/native-auth.js";
import { encodeMuxedAddress } from "../src/payment.js";
import { sc } from "../src/native-codec.js";
const C = (n: number) => StrKey.encodeContract(new Uint8Array(32).fill(n));
const user = Keypair.random(),
  relay = Keypair.random(),
  funding = C(1),
  registrar = C(2),
  resolver = C(3),
  lookup = C(4),
  primary = C(5);
const intent = {
  name: "sam.nova",
  actor: user.publicKey(),
  routingId: null,
  generation: 0n,
  destination: { address: user.publicKey(), memo: { type: "none" } },
  previous: null,
} as const;
const quote = {
  network: "01".repeat(32),
  funding,
  configRevision: 1n,
  fundId: "02".repeat(32),
  policyRevision: 2n,
  action: "reverse",
  actor: user.publicKey(),
  nonce: 0n,
  quoteId: "03".repeat(32),
  intentHash: sponsorIntentHash("reverse", intent),
  registrar,
  resolver,
  relayer: relay.publicKey(),
  charge: 10000n,
  issuedLedger: 100,
  expiresLedger: 120,
} as const;
const plan = sponsorPlan({ quote, intent }, lookup, primary, 100000n);
function entries() {
  return [
    new xdr.SorobanAuthorizationEntry({
      credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
      rootInvocation: authorizedInvocation(plan.relayerInvocation),
    }),
    new xdr.SorobanAuthorizationEntry({
      credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
        new xdr.SorobanAddressCredentials({
          address: new Address(user.publicKey()).toScAddress(),
          nonce: 42n,
          signatureExpirationLedger: 0,
          signature: xdr.ScVal.scvVoid(),
        }),
      ),
      rootInvocation: authorizedInvocation(plan.actorInvocation),
    }),
  ];
}
function tx(
  auth = entries(),
  args = plan.args,
  fee = "100",
  source = relay.publicKey(),
) {
  return new TransactionBuilder(new Account(source, "0"), {
    fee,
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.invokeContractFunction({
        contract: funding,
        function: plan.method,
        args,
        auth,
      }),
    )
    .setTimeout(60)
    .build();
}
test("quote XDR round trip preserves full bigint values and routing-aware hash", () => {
  assert.deepEqual(decodeSponsorQuote(encodeSponsorQuote(quote)), quote);
  const mux = {
    ...intent,
    routingId: 9007199254740993n,
    destination: {
      address: encodeMuxedAddress(user.publicKey(), "9007199254740993"),
      memo: { type: "none" },
    },
  } as const;
  assert.notEqual(sponsorIntentHash("reverse", mux), quote.intentHash);
  assert.notEqual(
    sponsorIntentHash("reverse", { ...mux, routingId: 9007199254740992n }),
    sponsorIntentHash("reverse", mux),
  );
});
test("actor receipt enum is explicit and strict", () => {
  assert.deepEqual(
    sponsorActorFromNative({
      nonce: 1n,
      claims: 0n,
      utc_day: 1n,
      identity_today: 0,
      last_receipt: ["Empty"],
    }),
    { nonce: 1n, claims: 0n, utcDay: 1n, identityToday: 0, lastReceipt: null },
  );
  assert.throws(() =>
    sponsorActorFromNative({
      nonce: 1n,
      claims: 0n,
      utc_day: 1n,
      identity_today: 0,
      last_receipt: null,
    }),
  );
});
test("exact user authorization signs without spending user XLM", async () => {
  const t = tx();
  const entry = validateSponsorTransaction(t, plan, 101);
  const signed = await authorizeEntry(entry, user, 120, Networks.TESTNET);
  const built = replaceSponsorAuth(t, [entries()[0], signed], Networks.TESTNET);
  validateSponsorTransaction(built, plan, 101, true);
  assert.equal(built.source, relay.publicKey());
  assert.equal(built.signatures.length, 0);
});
for (const attack of [
  "extra-authority",
  "missing-user",
  "relayer-debit",
  "user-debit",
  "wrong-actor",
  "wrong-call",
  "wrong-fee",
  "wrong-source",
  "expired",
  "unsigned-user",
])
  test(`sponsor refuses ${attack}`, () => {
    const auth = entries();
    let args = plan.args,
      fee = "100",
      source = relay.publicKey(),
      ledger = 101;
    if (attack === "extra-authority") auth.push(entries()[1]);
    if (attack === "missing-user") auth.pop();
    if (attack === "relayer-debit" || attack === "user-debit")
      auth[
        attack === "relayer-debit" ? 0 : 1
      ].rootInvocation.subInvocations.push(
        authorizedInvocation({
          contract: C(8),
          method: "transfer",
          args: [
            sc.address(user.publicKey()),
            sc.address(relay.publicKey()),
            sc.i128(99n),
          ],
        }),
      );
    if (
      attack === "wrong-actor" &&
      auth[1].credentials.type === "sorobanCredentialsAddress"
    )
      auth[1].credentials.address.address = new Address(
        relay.publicKey(),
      ).toScAddress();
    if (attack === "wrong-call") args = [sc.u64(9n), ...args];
    if (attack === "wrong-fee") fee = "100001";
    if (attack === "wrong-source") source = user.publicKey();
    if (attack === "expired") ledger = 120;
    assert.throws(() =>
      validateSponsorTransaction(
        tx(auth, args, fee, source),
        plan,
        ledger,
        attack === "unsigned-user",
      ),
    );
  });
test("cannot wrap an altered intent in a valid quote", () => {
  assert.throws(() =>
    sponsorPlan(
      { quote, intent: { ...intent, name: "john.nova" } },
      lookup,
      primary,
      100n,
    ),
  );
});
test("policy rejects missing budgets, disabled coverage and overlong quotes", () => {
  const p = {
    claimCap: 100n,
    reverseCap: 0n,
    primaryCap: 0n,
    dailyCap: 200n,
    totalCap: 300n,
    claimsPerWallet: 1n,
    identityPerDay: 0,
    relayer: relay.publicKey(),
    quoteLifetime: 60,
    validUntil: 2000000000n,
  };
  sponsorPolicyToScVal(p);
  for (const change of [
    { dailyCap: 0n },
    { claimCap: 201n },
    { quoteLifetime: 121 },
    { claimsPerWallet: 0n },
    { claimCap: 0n },
  ])
    assert.throws(() => sponsorPolicyToScVal({ ...p, ...change }));
});

test("SDK agrees with Rust-generated quote, actor and canonical intent hash", async () => {
  const fs = await import("node:fs/promises");
  const vector = JSON.parse(
    await fs.readFile(
      new URL("./fixtures/funding-interop.json", import.meta.url),
      "utf8",
    ),
  );
  const { claimIntentFromNative } = await import("../src/native-types.js");
  const { scValToNative } = await import("@stellar/stellar-sdk");
  const intent = claimIntentFromNative(
    scValToNative(xdr.ScVal.fromXDR(vector.claim_xdr, "base64")),
  );
  assert.equal(sponsorIntentHash("claim", intent), vector.claim_hash);
  const quote = decodeSponsorQuote(vector.quote_xdr);
  assert.equal(quote.intentHash, vector.claim_hash);
  assert.equal(quote.action, "claim");
  assert.equal(encodeSponsorQuote(quote), vector.quote_xdr);
  const actor = sponsorActorFromNative(
    scValToNative(xdr.ScVal.fromXDR(vector.empty_actor_xdr, "base64")),
  );
  assert.equal(actor.nonce, 0n);
  assert.equal(actor.lastReceipt, null);
});

for (const mode of [
  "success",
  "failed",
  "unconfirmed",
  "wrong-quote",
  "wrong-hash",
] as const)
  test(`service status must prove the original quote on chain: ${mode}`, async () => {
    const { SoranSponsorship } = await import("../src/funding-user.js");
    const { FundingServiceClient } = await import("../src/funding-service.js");
    const { Contract } = await import("@stellar/stellar-sdk");
    const { sponsorQuoteToScVal, sponsoredIdentityToScVal } = await import(
      "../src/funding-types.js"
    );
    const { hex } = await import("../src/native-codec.js");
    const chain = new SoranSponsorship({
      fundingId: funding,
      registryId: C(6),
      lookupId: lookup,
      primaryId: primary,
    });
    const expected = { ...quote, network: chain.networkId };
    const confirmedQuote =
      mode === "wrong-quote"
        ? { ...expected, quoteId: "ff".repeat(32) }
        : expected;
    const transaction = new TransactionBuilder(
      new Account(relay.publicKey(), "1"),
      { fee: "100", networkPassphrase: Networks.TESTNET },
    )
      .addOperation(
        new Contract(funding).call(
          "sponsor_reverse",
          sponsorQuoteToScVal(confirmedQuote),
          sponsoredIdentityToScVal(intent),
        ),
      )
      .setTimeout(60)
      .build();
    const transactionHash = hex(transaction.hash());
    let reads = 0;
    chain.server.getTransaction = async () => {
      reads++;
      return mode === "unconfirmed"
        ? ({ status: "NOT_FOUND" } as any)
        : ({
            status: mode === "failed" ? "FAILED" : "SUCCESS",
            ledger: 110,
            latestLedger: 110,
            resultXdr: new xdr.TransactionResult({
              feeCharged: 100n,
              result:
                mode === "failed"
                  ? xdr.TransactionResultResult.txFailed([
                      xdr.OperationResult.opBadAuth(),
                    ])
                  : xdr.TransactionResultResult.txSuccess([
                      xdr.OperationResult.opInner(
                        xdr.OperationResultTr.invokeHostFunction(
                          xdr.InvokeHostFunctionResult.invokeHostFunctionSuccess(
                            new Uint8Array(32),
                          ),
                        ),
                      ),
                    ]),
              ext: xdr.TransactionResultExt.v0(),
            }),
            txHash: mode === "wrong-hash" ? "00".repeat(32) : transactionHash,
            envelopeXdr: transaction.toEnvelope(),
          } as any);
    };
    chain.server.getLatestLedger = async () => ({ sequence: 110 }) as any;
    const service = new FundingServiceClient(
      "https://example.invalid",
      chain,
      async () =>
        new Response(
          JSON.stringify({
            id: expected.quoteId,
            status: mode === "failed" ? "failed" : "success",
            transactionHash,
          }),
        ),
      {
        async find() {
          return null;
        },
      },
    );
    if (mode === "success" || mode === "failed")
      assert.equal((await service.status(expected)).status, mode);
    else await assert.rejects(service.status(expected));
    assert.equal(reads, 1);
  });

// Custom accounts choose their own authorization encoding. Shape validation
// still binds the complete intent; actual authentication is enforced on chain.
for (const kind of [
  "bytes",
  "map",
  "vector",
  "void",
  "oversized",
  "expired",
  "wrong-tree",
] as const) {
  test(`custom C authorization remains bounded and exact: ${kind}`, () => {
    const actor = C(21);
    const i = {
      ...intent,
      actor,
      destination: { address: actor, memo: { type: "none" as const } },
    };
    const q = { ...quote, actor, intentHash: sponsorIntentHash("reverse", i) };
    const p = sponsorPlan({ quote: q, intent: i }, lookup, primary, 100000n);
    const signature =
      kind === "map"
        ? xdr.ScVal.scvMap([
            new xdr.ScMapEntry({
              key: xdr.ScVal.scvSymbol("proof"),
              val: sc.bytes(new Uint8Array(64)),
            }),
          ])
        : kind === "vector"
          ? xdr.ScVal.scvVec([sc.bytes(new Uint8Array(64))])
          : kind === "void"
            ? xdr.ScVal.scvVoid()
            : sc.bytes(new Uint8Array(kind === "oversized" ? 16385 : 64));
    const auth = [
      new xdr.SorobanAuthorizationEntry({
        credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
        rootInvocation: authorizedInvocation(p.relayerInvocation),
      }),
      new xdr.SorobanAuthorizationEntry({
        credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
          new xdr.SorobanAddressCredentials({
            address: new Address(actor).toScAddress(),
            nonce: 42n,
            signatureExpirationLedger: kind === "expired" ? 100 : 120,
            signature,
          }),
        ),
        rootInvocation: authorizedInvocation(
          kind === "wrong-tree" ? plan.actorInvocation : p.actorInvocation,
        ),
      }),
    ];
    const built = tx(auth, p.args);
    if (["oversized", "expired", "wrong-tree"].includes(kind)) {
      assert.throws(() => validateSponsorTransaction(built, p, 101, true));
    } else validateSponsorTransaction(built, p, 101, true);
  });
}
test("native G authorizers still reject custom bytes signatures", () => {
  const auth = entries();
  if (auth[1].credentials.type !== "sorobanCredentialsAddress")
    throw Error("fixture");
  auth[1].credentials.address.signature = sc.bytes(new Uint8Array(64));
  auth[1].credentials.address.signatureExpirationLedger = 120;
  assert.throws(() => validateSponsorTransaction(tx(auth), plan, 101, true));
});

test("default service transport keeps the browser fetch receiver", async () => {
  const { FundingServiceClient } = await import("../src/funding-service.js");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = function (this: unknown) {
    assert.equal(this, globalThis);
    return Promise.resolve(
      Response.json({
        id: quote.quoteId,
        status: "pending",
        transactionHash: "11".repeat(32),
      }),
    );
  } as typeof fetch;
  try {
    const service = new FundingServiceClient("https://sponsorship.invalid", {
      networkId: quote.network,
      fundingId: quote.funding,
    } as any);
    assert.equal((await service.status(quote)).status, "pending");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
