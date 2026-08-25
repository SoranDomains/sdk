/* Live testnet e2e for @sorandomains/holder.
 * Funds a fresh holder via friendbot, has the namespace owner issue it a name
 * (SORAN_ISSUER_SECRET = the namespace owner's key), then exercises every
 * holder power and cleans up. All reversible. Run:
 *   SORAN_ISSUER_SECRET=S… npx tsx e2e.ts            (namespace: acme) */
import { Keypair } from "@stellar/stellar-sdk";
import { SoranHolder, keypairSigner, HolderError } from "./src/index.js";
import { SoranOwner, keypairSigner as ownerSigner } from "../owner/src/index.js";
import { Soran } from "../lookup/src/index.js";

const issuerSecret = process.env.SORAN_ISSUER_SECRET;
if (!issuerSecret) throw new Error("set SORAN_ISSUER_SECRET (the namespace owner's key)");
const NS = process.env.SORAN_E2E_NAMESPACE ?? "acme";

let fails = 0;
const check = (n: string, ok: boolean, d = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${n}${d ? " — " + d : ""}`);
  if (!ok) fails++;
};

// 0. fresh funded holder + issued name
const kp = Keypair.random();
const res = await fetch(`https://friendbot.stellar.org?addr=${kp.publicKey()}`);
if (!res.ok) throw new Error(`friendbot failed: ${res.status}`);
const me = new SoranHolder({ signer: keypairSigner(kp.secret()) });
const owner = new SoranOwner({ signer: ownerSigner(issuerSecret) });
const lookup = new Soran();
const label = `holderdemo-${Date.now().toString(36).slice(-5)}`;
const name = `${label}.${NS}`;
await owner.issue(NS, label, kp.publicKey());
check("setup: name issued to fresh holder", (await lookup.resolve(name)) === kp.publicKey());

// 1. explicit resolver record: point at a sibling address, then back
const sibling = Keypair.random().publicKey();
await me.setRecord(name, sibling);
check("setRecord → resolves to new target", (await lookup.resolve(name)) === sibling);
await me.setRecord(name, kp.publicKey());
check("setRecord back → resolves to holder", (await lookup.resolve(name)) === kp.publicKey());

// 2. built-in target re-point (registrar record; resolver record still wins)
await me.setAddress(name, kp.publicKey());
check("setAddress accepted (built-in path)", true);

// 3. profile records → visible through lookup.profile()
const setKeys = await me.setProfile(name, { url: "https://example.org", org: "E2E Co" });
check("setProfile wrote 2 keys", setKeys.length === 2, setKeys.map((s) => s.key).join(","));
const prof = await lookup.profile(name);
check("lookup.profile shows records", prof.url === "https://example.org" && prof.org === "E2E Co", JSON.stringify(prof));

// 3b. clearText retraction: empty value → profile treats as unset
await me.clearText(name, "org");
const prof2 = await lookup.profile(name);
check("clearText retracts from profile", !("org" in prof2) && prof2.url === "https://example.org", JSON.stringify(prof2));

// 4. reverse record → discoverable; forward-mismatch refused with typed error
await me.setReverse(name);
check("reverseLookup finds the name", (await lookup.reverseLookup(kp.publicKey(), [NS])) === name);
try {
  await me.setReverse("alice.nova"); // not our name — forward points elsewhere
  check("foreign reverse refused", false);
} catch (e) {
  const he = e as HolderError;
  check("foreign reverse refused (ForwardMismatch)", he.codeName === "ForwardMismatch", `${he.codeName}`);
}

// 5. primary name → cross-namespace identity
await me.setPrimary(name);
check("primaryOf answers the name", (await lookup.primaryOf(kp.publicKey())) === name);

// 6. transfers (policy-gated — probe and adapt)
const pol = await owner.policy(NS);
if (pol.transferable) {
  const to = Keypair.random().publicKey();
  await me.proposeNameTransfer(name, to);
  const pend = (await me.pendingNameTransfer(name)) as { to?: string } | null;
  check("transfer proposed & visible", !!pend && String(pend.to) === to);
  await me.cancelNameTransfer(name);
  check("transfer cancelled", (await me.pendingNameTransfer(name)) === null);
} else {
  try {
    await me.proposeNameTransfer(name, Keypair.random().publicKey());
    check("non-transferable policy refused", false);
  } catch (e) {
    check("non-transferable policy refused (NotTransferable)", (e as HolderError).codeName === "NotTransferable");
  }
}

// 7. cleanup: clear primary + reverse, owner reclaims
await me.clearPrimary();
check("primary cleared", (await lookup.primaryOf(kp.publicKey())) === null);
await me.clearReverse(NS);
check("reverse cleared", (await lookup.reverseLookup(kp.publicKey(), [NS])) === null);
if (pol.reclaimable) {
  await owner.reclaim(NS, label);
  const st = await owner.nameState(NS, label);
  check("cleanup: name reclaimed", st !== null && st.holder !== kp.publicKey());
} else {
  console.log("skip cleanup reclaim (policy not reclaimable)");
}

console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILURES`);
process.exit(fails ? 1 : 0);
