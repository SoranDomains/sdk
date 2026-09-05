/** Read-only demo for the current testnet preset: npm run demo [-- issued.name] */
import { Soran, SoranError } from "./src/index.js";
const soran = new Soran({ network: "testnet", timeoutMs: 20_000 });
console.log("nova namespace metadata:", await soran.namespaceMetadata("nova"));
const name = process.argv[2];
if (name) {
  try {
    const payment = await soran.resolvePayment(name);
    console.log("Complete payment instructions:", payment);
    console.log("Fresh comparison:", await soran.verifyPayment(name, payment));
  } catch (error) {
    if (error instanceof SoranError && error.contractError === "NameInactive") {
      console.log("The supplied name is not currently active; no payment instructions are available.");
    } else throw error;
  }
} else {
  console.log("Supply an issued name to inspect complete address and memo instructions. No issued sample names are assumed by this fresh-deployment demo.");
}
