import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Keypair, scValToNative, xdr } from "@stellar/stellar-sdk";
import { SoranHolder, claimIntentFromNative, stringifyNativeIntent } from "@sorandomains/holder";
import { SoranOwner } from "@sorandomains/owner";
import { registerWriteTools } from "../src/tools.js";

test("native, legacy and owner writes share the payer queue; reads and refused confirmations do not wait", async () => {
  const holder = SoranHolder.prototype, owner = SoranOwner.prototype;
  const saved = { claim: holder.claim, setProfile: holder.setProfile, claimQuote: holder.claimQuote, renew: owner.renew, configureClaims: owner.configureClaims };
  const entered: string[] = [];
  let release!: () => void, started!: () => void;
  const blocking = new Promise<void>(resolve => { release = resolve; });
  const active = new Promise<void>(resolve => { started = resolve; });
  try {
    holder.claim = async () => { entered.push("native holder"); started(); await blocking; throw new Error("claim failed after reconciliation"); };
    holder.setProfile = async () => { entered.push("legacy holder"); return {} as any; };
    owner.renew = async () => { entered.push("legacy owner"); return {} as any; };
    owner.configureClaims = async () => { entered.push("native owner"); return {} as any; };
    holder.claimQuote = async () => { entered.push("read"); return {} as any; };
    const handlers = new Map<string, (args: any) => Promise<any>>();
    await registerWriteTools({ tool(name: string, _desc: string, _schema: any, callback: any) { handlers.set(name, callback); } } as any, { secret: Keypair.random().secret() });
    const invoke = async (name: string, args: any) => {
      const first = await handlers.get(name)!(args);
      const body = JSON.parse(first.content[0].text);
      return body.error === "ConfirmationRequired" ? handlers.get(name)!({ ...args, confirm: body.confirm }) : first;
    };
    const vector = JSON.parse(readFileSync(new URL("../../holder/test/fixtures/native-claim-v1.json", import.meta.url), "utf8"));
    const intent = claimIntentFromNative(scValToNative(xdr.ScVal.fromXDR(vector.claimIntentXdrHex, "hex")));
    const claim = invoke("claim_username", { intentJson: stringifyNativeIntent(intent) });
    await active;
    const profile = handlers.get("set_profile")!({ name: "alice.nova", profile: { org: "Alice" } });
    const renewal = handlers.get("renew_name")!({ namespace: "nova", label: "alice", extendSecs: 60 });
    const settings = { feeAmount: "0", walletLimit: "0", approvalAllowance: "0", approvalRateLimit: "0", approvalWindowSecs: "0", approvalTtlSecs: "0" };
    const refused = await handlers.get("configure_native_claims")!({ namespace: "nova", settings });
    assert.equal(JSON.parse(refused.content[0].text).error, "ConfirmationRequired");
    const configured = handlers.get("configure_native_claims")!({ namespace: "nova", settings, confirm: JSON.parse(refused.content[0].text).confirm });
    await handlers.get("native_claim_quote")!({ name: "alice.nova" });
    assert.deepEqual(entered, ["native holder", "read"], "no second writer reads a stale payer sequence while native write is pending");
    release();
    await Promise.all([claim, profile, renewal, configured]);
    assert.deepEqual(entered, ["native holder", "read", "legacy holder", "legacy owner", "native owner"], "a failed first write must release the payer queue");
  } finally {
    release?.();
    holder.claim = saved.claim; holder.setProfile = saved.setProfile; holder.claimQuote = saved.claimQuote;
    owner.renew = saved.renew; owner.configureClaims = saved.configureClaims;
  }
});
