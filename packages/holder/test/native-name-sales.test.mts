import assert from "node:assert/strict";
import test from "node:test";
import { Account, Asset, Keypair, Networks, SorobanDataBuilder, StrKey, Transaction, TransactionBuilder, xdr } from "@stellar/stellar-sdk";
import { SoranHolder, type PaymentDestination } from "../src/index.js";
import { authorizedInvocation, type NativeInvocation } from "../src/native-auth.js";
import { hex, namespaceNode, paymentDestinationToScVal, sc, utf8 } from "../src/native-codec.js";
import { resolvableNameNode } from "../src/names.js";
import { instanceProof } from "./helpers/native-ledger.mjs";

const contract = (n: number) => StrKey.encodeContract(new Uint8Array(32).fill(n));
const registry = contract(1), registrar = contract(2), resolver = contract(3);
const seller = Keypair.random(), buyer = Keypair.random();
const name = "alice.nova";
const request = { priceStroops: 9_007_199_254_740_993n, payout: seller.publicKey(), deadline: 4000n };
const rawListing = {
  label: utf8("alice"), node: resolvableNameNode(name), seller: seller.publicKey(), generation: 4n, revision: 2n,
  price: request.priceStroops, payout: request.payout, deadline: request.deadline,
  soran_bps: 500, soran_recipient: contract(4), soran_fee: request.priceStroops * 500n / 10000n,
  namespace_bps: 150, namespace_recipient: contract(5), namespace_fee: request.priceStroops * 150n / 10000n,
  seller_net: request.priceStroops - request.priceStroops * 500n / 10000n - request.priceStroops * 150n / 10000n,
};

function fixture(key = seller) {
  const terms = { ...rawListing };
  const record = { address: seller.publicKey(), holder: seller.publicKey(), generation: 4n, expires_at: 0n };
  const policy = { reclaimable: false, transferable: true, tradeable: true, default_term_secs: 0n, trade_fee_bps: 150 };
  let signatures = 0, sent: Transaction | null = null;
  const source = key.publicKey();
  const holder = new SoranHolder({ registryId: registry, signer: { publicKey: () => source, signTransaction: async (raw, options) => {
    signatures++;
    const tx = TransactionBuilder.fromXDR(raw, options.networkPassphrase);
    tx.sign(key);
    return tx.toXDR();
  } } });
  const fixture = {
    holder, terms, record, policy, version: 2 as number | Error, listing: true, deadlinePassed: false, wrongBinding: false,
    destination: null as PaymentDestination | null,
    tamper: undefined as undefined | "fees" | "initialize" | "extra-payment",
    signed: () => signatures,
  };
  Object.assign(holder, {
    read: async (_id: string, fn: string) => {
      switch (fn) {
        case "registrar_of": return registrar;
        case "name_sale_version": if (fixture.version instanceof Error) throw fixture.version; return fixture.version;
        case "registrar_tainted": return false;
        case "template_hashes": return [new Uint8Array(32), new Uint8Array(32)];
        case "native_contracts": return [fixture.wrongBinding ? contract(9) : registrar, resolver];
        case "anchors": return [registry, namespaceNode("nova")];
        case "name_listing": return fixture.listing && !fixture.deadlinePassed ? terms : null;
        case "name_listing_for_holder": return fixture.listing ? terms : null;
        case "policy": return policy;
        case "holder_and_generation": return [record.holder, record.generation];
        case "record_of": return record;
        case "quote_name_sale": return terms;
        default: throw new Error("unexpected method " + fn);
      }
    },
    server: {
      getContractInstance: async () => ({ executable: { type: "contractExecutableWasm", wasmHash: { value: new Uint8Array(32) } } }),
      getLedgerEntries: async () => instanceProof(registry),
      getAccount: async () => new Account(source, "10"),
      simulateTransaction: async (tx: Transaction) => {
        const op = tx.operations[0];
        if (op.type !== "invokeHostFunction" || op.func.type !== "hostFunctionTypeInvokeContract") throw new Error("expected a contract call");
        const call = op.func.invokeContract;
        const method = call.functionName.toString();
        const children: NativeInvocation[] = [];
        const makePayment = (receiver: string, amount: bigint) => ({
          contract: Asset.native().contractId(Networks.TESTNET), method: "transfer", args: [sc.address(source), sc.address(receiver), sc.i128(amount)],
        });
        if (method === "buy_name") {
          children.push(makePayment(terms.payout, terms.seller_net), makePayment(fixture.tamper === "fees" ? source : terms.soran_recipient, terms.soran_fee));
          if (terms.namespace_fee > 0n) children.push(makePayment(terms.namespace_recipient, terms.namespace_fee));
          if (fixture.destination) children.push({
            contract: resolver, method: "initialize_destination",
            args: [sc.bytes(terms.label), sc.address(source), sc.u64(fixture.tamper === "initialize" ? 6n : 5n), paymentDestinationToScVal(fixture.destination)],
          });
        }
        if (fixture.tamper === "extra-payment") children.push(makePayment(source, 1n));
        const auth = new xdr.SorobanAuthorizationEntry({
          credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
          rootInvocation: authorizedInvocation({ contract: registrar, method, args: call.args, children }),
        });
        return { _parsed: true, transactionData: new SorobanDataBuilder(), minResourceFee: "0", result: { auth: [auth], retval: xdr.ScVal.scvVoid() }, events: [], latestLedger: 90 };
      },
      sendTransaction: async (tx: Transaction) => { sent = tx; return { status: "PENDING", hash: hex(tx.hash()) }; },
      getTransaction: async () => ({ status: "SUCCESS", txHash: hex(sent!.hash()), envelopeXdr: sent!.toEnvelope(), ledger: 100, returnValue: xdr.ScVal.scvVoid() }),
    },
  });
  return fixture;
}

test("sales read current holder, scope a quote, and sign exact list and cancel calls", async () => {
  const f = fixture();
  f.listing = false;
  assert.deepEqual(await f.holder.nameSaleState("Alice.Nova"), { supported: true, eligible: true, holder: seller.publicKey(), listing: null });
  const quote = await f.holder.quoteNameSale(name, request);
  assert.equal(quote.soranFeeStroops, rawListing.soran_fee);
  assert.equal(quote.sellerNetStroops, rawListing.seller_net);
  assert.equal(quote.node, hex(resolvableNameNode(name)));
  assert.equal((await f.holder.listNameForSale(quote)).ledger, 100);
  f.listing = true;
  assert.equal((await f.holder.cancelNameListing(quote)).ledger, 100);
  f.terms.revision++;
  await assert.rejects(f.holder.cancelNameListing(quote), /terms changed/);
  assert.equal(f.signed(), 2);
});

test("purchase authorization checks every native XLM split and exact optional receiving instructions", async () => {
  const f = fixture(buyer);
  const quote = await f.holder.quoteNameSale(name, request);
  assert.equal((await f.holder.buyName(quote)).ledger, 100);
  f.destination = { address: contract(8), memo: { type: "none" } };
  assert.equal((await f.holder.buyName(quote, f.destination)).ledger, 100);
  for (const substitution of ["fees", "initialize", "extra-payment"] as const) {
    f.tamper = substitution;
    await assert.rejects(f.holder.buyName(quote, f.destination), /authorization differs/);
  }
  assert.equal(f.signed(), 2);
});

test("the holder can read and cancel an expired offer while checkout remains closed", async () => {
  const f = fixture();
  f.deadlinePassed = true;
  const state = await f.holder.nameSaleState(name);
  assert.ok(state.supported);
  assert.equal(state.listing, null);
  const stored = await f.holder.nameListingForHolder(name);
  assert.ok(stored);
  assert.equal(stored.revision, f.terms.revision);
  assert.equal(await f.holder.nameListingForHolder(name, buyer.publicKey()), null);
  const b = fixture(buyer);
  b.deadlinePassed = true;
  await assert.rejects(b.holder.buyName(stored), /terms changed/);
  await assert.rejects(b.holder.cancelNameListing(stored), /listing seller/);
  assert.equal(b.signed(), 0);
  // A Resolver change can disable the market while ownership and cleanup remain valid.
  f.wrongBinding = true;
  await assert.rejects(f.holder.nameSaleState(name), /not bound/);
  assert.deepEqual(await f.holder.nameListingForHolder(name), stored);
  assert.equal((await f.holder.cancelNameListing(stored)).ledger, 100);
  assert.equal(f.signed(), 1);
  f.record.generation++;
  await assert.rejects(f.holder.cancelNameListing(stored), /ownership disagree/);
  assert.equal(f.signed(), 1);
  f.listing = false;
  assert.equal(await f.holder.nameListingForHolder(name), null);
});

test("stale, malformed, wrong network and wrong account are rejected before requesting a signature", async () => {
  const f = fixture(buyer);
  const quote = await f.holder.quoteNameSale(name, request);
  await assert.rejects(f.holder.listNameForSale(quote), /listing seller/);
  await assert.rejects(f.holder.buyName({ ...quote, networkPassphrase: Networks.PUBLIC }), /different deployment/);
  await assert.rejects(f.holder.buyName({ ...quote, registrar: contract(9) }), /different deployment/);
  await assert.rejects(f.holder.buyName({ ...quote, name: "different.nova" }), /another name/);
  f.terms.soran_fee++;
  await assert.rejects(f.holder.buyName(quote), /proceeds do not match/);
  f.terms.soran_fee--;
  f.listing = false;
  await assert.rejects(f.holder.buyName(quote), /terms changed/);
  assert.equal(f.signed(), 0);
  const s = fixture();
  await assert.rejects(s.holder.buyName(quote), /own listing/);
});

test("unavailable RPC and wrong provenance remain distinct from older or ineligible contracts", async () => {
  const f = fixture();
  f.version = new Error("Error(WasmVm, MissingValue)");
  assert.deepEqual(await f.holder.nameSaleState(name), { supported: false });
  f.version = new Error("RPC timed out");
  await assert.rejects(f.holder.nameSaleState(name), /timed out/);
  f.version = 1;
  assert.deepEqual(await f.holder.nameSaleState(name), { supported: false });
  assert.equal(await f.holder.nameListingForHolder(name), null);
  f.version = 2;
  f.listing = false;
  f.policy.reclaimable = true;
  assert.deepEqual(await f.holder.nameSaleState(name), { supported: true, eligible: false, holder: seller.publicKey(), listing: null });
  f.wrongBinding = true;
  await assert.rejects(f.holder.nameSaleState(name), /not bound/);
  await assert.rejects(f.holder.nameSaleState("nested.alice.nova"), /direct names/);
});
