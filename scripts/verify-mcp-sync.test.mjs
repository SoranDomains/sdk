import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { verifyMcpSync } from './verify-mcp-sync.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const original = fs.readFileSync;
function modified(file, transform, run) {
  fs.readFileSync = function(input, ...args) {
    const result = original.call(this, input, ...args);
    if (path.resolve(String(input)) !== path.join(root, file)) return result;
    const value = transform(result.toString());
    return typeof result === 'string' ? value : Buffer.from(value);
  };
  try { run(); } finally { fs.readFileSync = original; }
}
const jsonProbe = (file, mutation) => modified(file, text => { const value = JSON.parse(text); mutation(value); return JSON.stringify(value); }, () => assert.throws(() => verifyMcpSync(root)));
test('MCP and native-signup projection preserves all portable source files', () => assert.equal(verifyMcpSync(root).mappedFiles, 45));
test('runtime byte drift is rejected', () => modified('packages/mcp/src/tools.ts', x => x + '\n', () => assert.throws(() => verifyMcpSync(root), /Export drift/)));
test('missing mapping, wrong revision and traversal are rejected', () => {
  for (const mutation of [m => m.files.pop(), m => m.sourceRevision = '0'.repeat(40), m => m.files[0].destination = '../outside']) jsonProbe('mcp-sync-manifest.json', mutation);
});
test('private API omission must remain an explicit source-CI gate', () => {
  for (const mutation of [m => m.omitted = [], m => m.omitted[0].requiredMonorepoCi = false, m => m.omitted[0].sourceSha256 = '0'.repeat(64)]) jsonProbe('mcp-sync-manifest.json', mutation);
});
test('dependency integrity metadata cannot drift', () => jsonProbe('mcp-sync-manifest.json', m => m.coreDependencies['node_modules/@sorandomains/holder'].integrity = 'sha512-invalid'));
test('shared documentation cannot silently relabel core provenance', () => jsonProbe('sync-manifest.json', m => m.files.find(x => x.destination === 'README.md').sourceRevision = m.sourceRevision));
test('portable test mapping cannot omit a test', () => jsonProbe('mcp-sync-manifest.json', m => m.portableTests.pop()));

test('retained public regression tests remain covered', () => jsonProbe('mcp-sync-manifest.json', m => m.retainedPublicTests.pop()));
