/* Live testnet e2e for @sorandomains/owner against the acme namespace.
 * All operations reversible; make_permanent tested guard-only (never submitted). */
import { Keypair } from "@stellar/stellar-sdk";
import { SoranOwner, keypairSigner, OwnerError } from "./src/index.js";
import { Soran } from "../lookup/src/index.js";

const secret = process.env.SORAN_OWNER_SECRET;
if (!secret) throw new Error("set SORAN_OWNER_SECRET to the namespace owner's secret key");
const NS_ENV = process.env.SORAN_E2E_NAMESPACE ?? "acme";
const signer = keypairSigner(secret);
const owner = new SoranOwner({ signer });
const lookup = new Soran(); // independent read path for verification

const NS = NS_ENV;
const stamp = Date.now().toString(36).slice(-6);
const L1 = `sdkw-${stamp}`;         // single issue
const L2 = `sdkw-${stamp}-b1`;      // batch fresh
const L3 = `sdkw-${stamp}-b2`;      // batch fresh
const holder1 = Keypair.random().publicKey();
const holder2 = Keypair.random().publicKey();

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

// 0. preflight
await owner.assertOwner(NS);
check("assertOwner(acme)", true);
const pol = await owner.policy(NS);
console.log(`policy: reclaimable=${pol.reclaimable} term=${pol.defaultTermSecs}s`);
check("isPermanent=false", (await owner.isPermanent(NS)) === false);

// 1. single issue + independent lookup verification
const iss = await owner.issue(NS, L1, holder1);
check("issue", !!iss.hash && iss.node.length === 64, `${L1}.${NS} @ ledger ${iss.ledger}`);
check("lookup.resolve matches holder", (await lookup.resolve(`${L1}.${NS}`)) === holder1);

// 2. batch: fresh + fresh + TAKEN (L1 again) + in-batch duplicate of L2
const batch = await owner.issueBatch(NS, [
  { label: L2, holder: holder1 },
  { label: L3, holder: holder2 },
  { label: L1, holder: holder2 },       // already held → taken
  { label: L2, holder: holder2 },       // in-batch dup → skipped
]);
const by = Object.fromEntries(batch.outcomes.map((o, i) => [`${i}:${o.label}`, o]));
check("batch issuedCount=2", batch.issuedCount === 2, `count=${batch.issuedCount}`);
check("batch outcomes from events", batch.outcomeSource === "events", batch.outcomeSource);
check("batch countMatches", batch.countMatches);
check("batch fresh L2 issued", by[`0:${L2}`].issued);
check("batch fresh L3 issued", by[`1:${L3}`].issued);
check("batch taken L1 reported taken", !by[`2:${L1}`].issued && by[`2:${L1}`].reason === "taken");
check("batch dup L2 reported not-issued", !by[`3:${L2}`].issued, `reason=${by[`3:${L2}`].reason}`);
check("L1 still holder1 (not stolen by batch)", (await lookup.resolve(`${L1}.${NS}`)) === holder1);

// 3. renew (finite policy only)
if (pol.defaultTermSecs > 0n) {
  const before = (await owner.nameState(NS, L1))!.expiresAt;
  const ren = await owner.renew(NS, L1, 3600);
  check("renew +1h", ren.expiresAt === before + 3600n, `${before} → ${ren.expiresAt}`);
} else {
  console.log("skip renew (permanent-term policy)");
}

// 4. typed errors: reclaim as non-owner must fail (funded stranger → typed
// NotNamespaceOwner; unfunded random → wrapped account-not-found OwnerError)
const otherSecret = process.env.SORAN_E2E_OTHER_SECRET;
const rando = new SoranOwner({
  signer: keypairSigner(otherSecret ?? Keypair.random().secret()),
});
try {
  await rando.reclaim(NS, L1);
  check("non-owner reclaim rejected", false);
} catch (e) {
  const oe = e as OwnerError;
  // Wrong-signer calls are refused BEFORE submission (recorded auth demands
  // the owner's address) — no fee spent, clear message naming both parties.
  const failFast = otherSecret ? /must be authorized by/.test(oe.message) && oe.txHash === null : true;
  check("non-owner reclaim rejected pre-submit", oe instanceof OwnerError && failFast, oe.message.slice(0, 90));
}

// 5. makePermanent guard (never submitted)
try {
  // @ts-expect-error deliberate misuse
  await owner.makePermanent(NS, {});
  check("makePermanent guard", false);
} catch (e) {
  check("makePermanent guard", String(e).includes("IRREVERSIBLE"));
}

// 6. namespace transfer: propose → pending visible → cancel → pending gone
const buyer = Keypair.random().publicKey();
await owner.proposeNamespaceTransfer(NS, buyer);
const pend = (await owner.pendingNamespaceTransfer(NS)) as { to?: string } | null;
check("pending transfer visible", !!pend && String(pend.to) === buyer);
await owner.cancelNamespaceTransfer(NS);
check("pending transfer cancelled", (await owner.pendingNamespaceTransfer(NS)) === null);

// 7. cleanup: reclaim all three (policy permitting), verify resolution gone
if (pol.reclaimable) {
  for (const l of [L1, L2, L3]) await owner.reclaim(NS, l);
  const st = await owner.nameState(NS, L1);
  check("cleanup: reclaim moved L1 off holder1", st !== null && st.holder !== holder1,
    `holder now ${st?.holder.slice(0, 8)}…`);
} else {
  console.log("skip cleanup reclaim (policy not reclaimable) — names left issued");
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
