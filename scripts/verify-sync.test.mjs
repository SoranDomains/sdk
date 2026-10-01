import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { verifySync } from './verify-sync.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const files = new Map();
// Mutation probes operate in memory, so no checkout or held source files change.
const original = fs.readFileSync;
function modified(file, transform, run) {
  fs.readFileSync = function (input, ...args) {
    const result = original.call(this, input, ...args);
    if (path.resolve(String(input)) !== path.join(root, file)) return result;
    const value = transform(result.toString());
    return typeof result === 'string' ? value : Buffer.from(value);
  };
  try { run(); } finally { fs.readFileSync = original; }
}
test('reviewed export and public fixtures are complete and unchanged', () => assert.equal(verifySync(root).mappedFiles, 143));
test('production byte drift is rejected', () => modified('packages/lookup/src/index.ts', x => x + '\n', () => assert.throws(() => verifySync(root), /Export drift/)));
test('ABI fixture drift is rejected', () => modified('fixtures/public-abi-errors.json', x => x.replace('"53"', '"999"'), () => assert.throws(() => verifySync(root), /Fixture drift/)));
test('path traversal and source revision changes are rejected', () => {
  for (const transform of [r => r.files[0].destination = '../outside', r => r.sourceRevision = '0'.repeat(40)]) modified('sync-manifest.json', x => { const r = JSON.parse(x); transform(r); return JSON.stringify(r); }, () => assert.throws(() => verifySync(root)));
});
