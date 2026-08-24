/** Live demo against the public testnet deployment: `npm run demo` */
import { Soran } from "./src/index.js";

const soran = new Soran({ network: "testnet" });

console.log("— @sorandomains/lookup live demo (public testnet, pure chain reads) —");

const addr = await soran.resolve("alice.nova");
console.log(`resolve("alice.nova")            → ${addr}`);

const rec = await soran.record("alice.nova");
console.log(`record().resolver                → ${rec.resolver?.slice(0, 10)}…`);

console.log(`verify("alice.nova", that addr)  → ${await soran.verify("alice.nova", addr!)}`);
console.log(`verify("alice.nova", WRONG addr) → ${await soran.verify("alice.nova", "GAAHFS7CISNAJOQK5VS447NS6ZFPRLLQQP6IM2EA4W7XZWGJNMXZ4VLK")}`);

console.log(`reverseVerify(addr,"alice.nova") → ${await soran.reverseVerify(addr!, "alice.nova")}`);
console.log(`reverseVerify(addr,"bob.nova")   → ${await soran.reverseVerify(addr!, "bob.nova")}`);

const ns = await soran.namespace("nova");
console.log(`namespace("nova").owner          → ${ns?.owner.slice(0, 8)}…`);
console.log(`isAvailable("nova")              → ${await soran.isAvailable("nova")}`);
console.log(`isAvailable("totally-free-name") → ${await soran.isAvailable("totally-free-name")}`);

console.log(`resolve("ghost.nova")            → ${await soran.resolve("ghost.nova")}`);
