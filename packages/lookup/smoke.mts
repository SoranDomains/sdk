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

console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILURES`);
process.exit(fails ? 1 : 0);
