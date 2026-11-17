import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { StrKey } from "@stellar/stellar-sdk";
import * as lookup from "../src/payment.js";
import * as holder from "../../holder/src/payment.js";
import * as owner from "../../owner/src/payment.js";

test("each SDK uses the reviewed payment codec for its public source snapshot", () => {
  const read = (pkg: string) => readFileSync(new URL(`../../${pkg}/src/payment.ts`, import.meta.url));
  const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
  // Lookup 0.11.0 is the October mirror source. Holder 0.12.0 and Owner 0.13.1 add W destinations.
  assert.equal(sha256(read("lookup")), "20494b8e99ae3d0de87d7aaaf738212947358ed162725a91dea90a616d78ad87");
  assert.equal(sha256(read("holder")), "b1dce15a10e1a3cb261c8a08d25e57b91a16d53d6e43f563b9b8f73529997956");
  assert.deepEqual(read("owner"), read("holder"));
});

test("all three package versions preserve the wire format and payment instructions for shared destinations", () => {
  const account = StrKey.encodeEd25519PublicKey(new Uint8Array(32).fill(7));
  const contract = StrKey.encodeContract(new Uint8Array(32).fill(9));
  const id = "18446744073709551615";
  const muxed = lookup.encodeMuxedAddress(account, id);
  const inputs: lookup.PaymentDestination[] = [
    { address: account, memo: { type: "none" } },
    { address: account, memo: { type: "id", value: id } },
    { address: account, memo: { type: "text", value: "Soran ✓" } },
    { address: account, memo: { type: "hash", value: "1f".repeat(32) } },
    { address: contract, memo: { type: "none" } },
    { address: muxed, memo: { type: "none" } },
  ];
  for (const codec of [lookup, holder, owner]) {
    assert.equal(codec.encodeMuxedAddress(account, id), muxed);
    assert.deepEqual(codec.decodeMuxedAddress(muxed), { account, id });
    for (const destination of inputs) {
      const record = lookup.encodePaymentRecord(destination);
      assert.equal(codec.encodePaymentRecord(destination), record);
      assert.deepEqual(codec.parsePaymentRecord(record), destination);
      assert.equal(codec.paymentMemoToScVal(destination.memo).toXDR("hex"), lookup.paymentMemoToScVal(destination.memo).toXDR("hex"));
    }
    assert.throws(() => codec.encodePaymentRecord({ address: muxed, memo: { type: "text", value: "extra" } }));
  }
});
