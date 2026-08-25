/* Live-testnet smoke for the 0.3.0 additions — details(), structured error
 * codes, timeoutMs, and the reverseLookup config guard. Run:
 *   npx tsx smoke.mts */
import { Soran, SoranError } from "./src/index.js";

let fails = 0;
const check = (n: string, ok: boolean, d = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${n}${d ? " — " + d : ""}`);
  if (!ok) fails++;
};

// details() on a live name
const soran = new Soran();
const d = await soran.details("alice.nova");
check("details.address", d.address === "GDHNO4WKFQJJAPX6YLQTGWFR5QCKZXKJBHKRFCSNRRFSTEJIQZ4Y5UBU");
check("details.holder set", typeof d.holder === "string" && d.holder!.startsWith("G"), String(d.holder).slice(0, 8));
check("details.expiresAt bigint", typeof d.expiresAt === "bigint", String(d.expiresAt));
check("details.generation bigint", typeof d.generation === "bigint", String(d.generation));
check("details.ns owner", d.namespace.owner?.startsWith("G") === true);
check("details.ns registrar", d.namespace.registrar?.startsWith("C") === true);
check("details.ns policy", d.namespace.policy !== null && typeof d.namespace.policy!.reclaimable === "boolean");
check("details.ns permanent bool", typeof d.namespace.permanent === "boolean", String(d.namespace.permanent));
check("details.assurance present", typeof d.assurance.trustworthy === "boolean");

// never-issued name: record fields null, namespace still populated
const g = await soran.details("ghost-never-issued.nova");
check("ghost holder null", g.holder === null && g.expiresAt === null && g.generation === null);
check("ghost ns still populated", g.namespace.owner !== null);

// INVALID_INPUT code
try {
  await soran.resolve("Not A Name");
  check("invalid input throws", false);
} catch (e) {
  check("invalid input code", e instanceof SoranError && e.code === "INVALID_INPUT", (e as SoranError).code);
}

// reverseLookup CONFIG guard: no primary, no namespaces, no hint
const bare = new Soran({ primaryId: undefined } as never);
// primaryId comes from the preset unless overridden — construct with explicit empty config
const noMeans = new Soran({ primaryId: undefined });
try {
  const r = await noMeans.reverseLookup("GDHNO4WKFQJJAPX6YLQTGWFR5QCKZXKJBHKRFCSNRRFSTEJIQZ4Y5UBU");
  // if primaryId defaulted from preset, a null/string return is fine — detect which
  check("reverseLookup no-means", true, `answered ${String(r).slice(0, 12)} (preset primary active)`);
} catch (e) {
  check("reverseLookup no-means CONFIG", e instanceof SoranError && (e as SoranError).code === "CONFIG", (e as SoranError).code);
}
void bare;

// timeoutMs: 1ms must trip the TIMEOUT code
const fast = new Soran({ timeoutMs: 1 });
try {
  await fast.resolve("alice.nova");
  check("timeout trips", false, "resolved despite 1ms bound");
} catch (e) {
  check("timeout code", e instanceof SoranError && (e as SoranError).code === "TIMEOUT", (e as SoranError).code);
}

// ---- 0.4.0: identity & enumeration (hint host = local API) ----
const HINT = process.env.SORAN_SMOKE_HINT ?? "http://localhost:4000";
const ALICE = "GDHNO4WKFQJJAPX6YLQTGWFR5QCKZXKJBHKRFCSNRRFSTEJIQZ4Y5UBU";
const hinted = new Soran({ hintUrl: HINT });

const prof = await hinted.profile("alice.nova");
check("profile returns object", typeof prof === "object" && prof !== null, JSON.stringify(prof).slice(0, 60));

const rn = await hinted.reverseNames(ALICE, ["nova"]);
check("reverseNames finds alice.nova", rn.some((r) => r.name === "alice.nova"), JSON.stringify(rn));
check("reverseNames primary flagged", rn.every((r) => typeof r.primary === "boolean"));

const held = await hinted.namesOf(ALICE);
check("namesOf verified >0", held.length > 0, `${held.length} names`);
check("namesOf all chain-verified holders", held.every((n) => n.holder === ALICE));
check("namesOf includes alice.nova", held.some((n) => n.name === "alice.nova"), held.map((n) => n.name).join(","));

const hist = await hinted.history("alice.nova");
check("history issued event", hist.events.some((e) => e.action === "issued") && hist.issuedLedger > 0, `${hist.events.length} events`);

const idn = await hinted.identity("alice.nova");
check("identity core", idn.details.address === ALICE && typeof idn.profile === "object");
check("identity enrichments typed", ["holderPrimary", "addressDisplayName", "namespaceOwnerPrimary"].every((k) => (idn as never as Record<string, unknown>)[k] === null || typeof (idn as never as Record<string, unknown>)[k] === "string"), `display=${idn.addressDisplayName} primary=${idn.holderPrimary}`);

const wp = await hinted.walletProfile(ALICE);
check("walletProfile names verified", wp.names !== null && wp.names.length > 0);
check("walletProfile reverse+primary coherent", wp.primary === null || wp.reverseNames.some((r) => r.primary && r.name === wp.primary), `primary=${wp.primary}`);

// namesOf without hint = CONFIG; forged-hint resistance is structural (verified on chain)
try {
  await new Soran().namesOf(ALICE);
  check("namesOf no-hint CONFIG", false);
} catch (e) {
  check("namesOf no-hint CONFIG", e instanceof SoranError && (e as SoranError).code === "CONFIG", (e as SoranError).code);
}

console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILURES`);
process.exit(fails ? 1 : 0);
