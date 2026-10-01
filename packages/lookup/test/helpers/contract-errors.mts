import { readFileSync } from "node:fs";

const root = new URL("../../../../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path.replace(/^sdk\//, "packages/"), root), "utf8");

/** The `#[contracterror]` Error enum of a contract crate: discriminant -> variant name. */
export function contractErrors(contract: string): Record<number, string> {
  const metadata = JSON.parse(read("fixtures/public-abi-errors.json"));
  if (metadata.sourceRevision !== "cec2d29bd392c64ac3e7f8d1d20d626736c72ce5") throw new Error("ABI fixture source revision changed");
  const row = metadata.contracts[contract];
  if (!row || !row.errors || Object.keys(row.errors).length === 0) throw new Error("Missing public contract error metadata: " + contract);
  return row.errors;
}

/** A `NAME: Record<number, string> = { 1: "A", ... }` table read from an SDK source file, for maps that are not exported. */
export function sourceErrorMap(file: string, name: string): Record<number, string> {
  const source = read(file);
  const declaration = new RegExp(`(?:const|let) ${name}\\b[^=]*=\\s*(?:Object\\.freeze\\()?\\{`).exec(source);
  if (!declaration) throw new Error(`${name} not found in ${file}`);
  const start = declaration.index + declaration[0].length;
  const out: Record<number, string> = {};
  for (const match of source.slice(start, source.indexOf("}", start)).matchAll(/(\d+):\s*"([^"]+)"/g)) out[Number(match[1])] = match[2];
  return out;
}

/** Only the codes of a table whose values are human sentences (Funding), in source order. */
export function sourceErrorCodes(file: string, name: string): number[] {
  const source = read(file);
  const start = source.indexOf("{", source.indexOf(`const ${name}`));
  return [...source.slice(start, source.indexOf("\n};", start)).matchAll(/^\s*(\d+):/gm)].map(match => Number(match[1]));
}

/** Fail with every missing, wrong and stale code at once. */
export function describeDrift(actual: Record<number, string>, expected: Record<number, string>): string[] {
  const problems: string[] = [];
  for (const code of Object.keys(expected).map(Number)) {
    if (!(code in actual)) problems.push(`missing ${code}: ${expected[code]}`);
    else if (actual[code] !== expected[code]) problems.push(`${code}: SDK says ${actual[code]}, contract says ${expected[code]}`);
  }
  for (const code of Object.keys(actual).map(Number)) if (!(code in expected)) problems.push(`stale ${code}: ${actual[code]} is not in the contract`);
  return problems;
}
