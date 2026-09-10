import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Account, Contract, Keypair, Networks, Operation, SorobanDataBuilder, StrKey, TransactionBuilder } from "@stellar/stellar-sdk";
import { SoranOwner } from "@sorandomains/owner";
import { feeBoundSigner, networkFeeLimit } from "../src/fee-policy.js";
import { registerWriteTools } from "../src/tools.js";

const key = Keypair.random(), contract = StrKey.encodeContract(new Uint8Array(32).fill(9));
test("operator cap covers ordinary and restoration envelopes before the underlying signer", async () => {
  let signed = 0;
  const signer = feeBoundSigner({ publicKey: () => key.publicKey(), signTransaction: async encoded => { signed++; return encoded; } }, 50_000_000n);
  for (const restore of [false, true]) {
    const builder = new TransactionBuilder(new Account(key.publicKey(), "1"), { fee: restore ? "100" : "500000100", networkPassphrase: Networks.TESTNET }).setTimeout(60);
    if (restore) builder.addOperation(Operation.restoreFootprint({})).setSorobanData(new SorobanDataBuilder().setResourceFee("500000000").build());
    else builder.addOperation(new Contract(contract).call("renew"));
    await assert.rejects(signer.signTransaction(builder.build().toXDR(), { networkPassphrase: Networks.TESTNET }), /operator maximum/);
  }
  assert.equal(signed, 0);
  const accepted = new TransactionBuilder(new Account(key.publicKey(), "1"), { fee: "50000000", networkPassphrase: Networks.TESTNET }).addOperation(new Contract(contract).call("renew")).setTimeout(60).build();
  await signer.signTransaction(accepted.toXDR(), { networkPassphrase: Networks.TESTNET }); assert.equal(signed, 1);
});

test("registered legacy SDK tool cannot evade the local operator limit", async () => {
  const original = SoranOwner.prototype.renew;
  try {
    SoranOwner.prototype.renew = async function () {
      const signer = (this as any).signer;
      const tx = new TransactionBuilder(new Account(await signer.publicKey(), "1"), { fee: "500000100", networkPassphrase: Networks.TESTNET }).addOperation(new Contract(contract).call("renew")).setTimeout(60).build();
      await signer.signTransaction(tx.toXDR(), { networkPassphrase: Networks.TESTNET });
      throw new Error("SIGNING_SHOULD_HAVE_BEEN_BLOCKED");
    };
    const handlers = new Map<string, (args: any) => Promise<any>>();
    await registerWriteTools({ tool(name: string, _desc: string, _schema: any, handler: any) { handlers.set(name, handler); } } as any, { secret: key.secret() });
    const result = await handlers.get("renew_name")!({ namespace: "nova", label: "audit", extendSecs: 60 });
    assert.equal(result.isError, true); assert.match(result.content[0].text, /operator maximum 50000000/);
  } finally { SoranOwner.prototype.renew = original; }
});

test("cap options keep native override compatibility and reject invalid values", () => {
  assert.equal(networkFeeLimit({}), 50_000_000n);
  assert.equal(networkFeeLimit({ maxNativeFeeStroops: 600_000_000n }), 600_000_000n);
  assert.equal(networkFeeLimit({ maxNetworkFeeStroops: 1000n, maxNativeFeeStroops: 600_000_000n }), 1000n);
  for (const value of [0n, -1n, 4294967296n, 1, "1"]) assert.throws(() => networkFeeLimit({ maxNetworkFeeStroops: value } as any), /maximum network fee/);
});

test("stdio rejects malformed total fee limits before write-tool registration", () => {
  for (const value of ["0", "050000000", "4294967296", "50000000n"]) {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL("../dist/stdio.js", import.meta.url))], { env: { SORAN_MAX_NETWORK_FEE_STROOPS: value }, encoding: "utf8", timeout: 5000 });
    assert.notEqual(result.status, 0); assert.match(result.stderr, /SORAN_MAX_NETWORK_FEE_STROOPS must be canonical decimal/);
  }
});

test("every SDK signer rejects unbounded or expired signing requests", async () => {
  let signed = 0;
  const signer = feeBoundSigner({ publicKey: () => key.publicKey(), signTransaction: async encoded => { signed++; return encoded; } }, 50_000_000n);
  const now = Math.floor(Date.now() / 1000);
  for (const maxTime of [0, now - 1, now + 600]) {
    const tx = new TransactionBuilder(new Account(key.publicKey(), "1"), { fee: "100", networkPassphrase: Networks.TESTNET, timebounds: { minTime: 0, maxTime } }).addOperation(new Contract(contract).call("renew")).build();
    await assert.rejects(signer.signTransaction(tx.toXDR(), { networkPassphrase: Networks.TESTNET }), /expire within five minutes/);
  }
  assert.equal(signed, 0);
});
