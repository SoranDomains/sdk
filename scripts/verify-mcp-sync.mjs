import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SOURCE_REVISION, MCP_REVISION, verifySync } from './verify-sync.mjs';
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const safe = value => typeof value === 'string' && /^(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+$/.test(value) && !value.split('/').some(x => x === '.' || x === '..');
function bytes(root, relative) {
  assert(safe(relative), 'Unsafe mapping path');
  const target = path.join(root, relative);
  assert(fs.lstatSync(target).isFile() && !fs.lstatSync(target).isSymbolicLink());
  return fs.readFileSync(target);
}
function listedFiles(root, relative) {
  return fs.readdirSync(path.join(root, relative), { withFileTypes: true }).flatMap(entry => {
    if (['node_modules', 'dist', '.DS_Store'].includes(entry.name) || entry.name.endsWith('.log')) return [];
    const item = relative + entry.name;
    assert(!entry.isSymbolicLink(), `Unexpected symlink: ${item}`);
    return entry.isDirectory() ? listedFiles(root, item + '/') : [item];
  });
}
export function verifyMcpSync(root) {
  verifySync(root);
  const manifest = JSON.parse(bytes(root, 'mcp-sync-manifest.json'));
  assert.equal(manifest.format, 'soran-public-mcp-sync-v1');
  assert.equal(manifest.sourceRevision, MCP_REVISION);
  assert.equal(manifest.coreSourceRevision, SOURCE_REVISION);
  assert.equal(manifest.mirrorBase, '891330d5451ff3b9f3b4285c5811298a1d972846');
  assert.equal(manifest.coreSyncManifestSha256, 'ae6180af3d7e2cf31eb8675590301e880acea17a011731af5319cefec1693233');
  assert.equal(manifest.productionSourceByteIdentical, true);
  assert.equal(manifest.testScriptUnchanged, true);
  assert.equal(manifest.publishFileListUnchanged, true);
  assert.equal(manifest.files.length, 43);
  const seen = new Set();
  for (const row of manifest.files) {
    assert(safe(row.source) && safe(row.destination), 'Unsafe mapping path');
    assert(!seen.has(row.destination), `Duplicate mapping: ${row.destination}`);
    seen.add(row.destination);
    assert(row.destination.startsWith('packages/mcp/') || row.destination.startsWith('examples/native-signup/'), 'Out-of-scope mapping');
    assert.equal(row.source, row.destination.startsWith('packages/mcp/') ? row.destination.replace('packages/mcp/', 'sdk/mcp/') : 'sdk/' + row.destination);
    assert(/^[a-f0-9]{64}$/.test(row.sourceSha256) && /^[a-f0-9]{64}$/.test(row.destinationSha256));
    assert.equal(sha256(bytes(root, row.destination)), row.destinationSha256, `Export drift: ${row.destination}`);
    if (row.destination !== 'packages/mcp/README.md') {
      assert.equal(row.exact, true, `Transformed source: ${row.destination}`);
      assert.equal(row.sourceSha256, row.destinationSha256);
    } else assert.equal(row.exact, false);
  }
  assert.deepEqual(manifest.retainedPublicTests.map(x => x.destination).sort(), ['packages/mcp/test/session-scope.test.mts', 'packages/mcp/test/submission.test.mts']);
  for (const row of manifest.retainedPublicTests) {
    assert.equal(row.sourceRepository, 'SoranDomains/sdk');
    assert.equal(row.sourceRevision, manifest.mirrorBase);
    assert.equal(row.source, row.destination);
    assert(/^[a-f0-9]{64}$/.test(row.sourceSha256));
    assert(!seen.has(row.destination));
    seen.add(row.destination);
    assert.equal(sha256(bytes(root, row.destination)), row.destinationSha256, `Retained test drift: ${row.destination}`);
    if (row.exact) assert.equal(row.sourceSha256, row.destinationSha256);
  }
  const allFiles = ['packages/mcp/', 'examples/native-signup/'].flatMap(prefix => listedFiles(root, prefix));
  assert.deepEqual(allFiles.sort(), [...seen].sort(), 'Managed file inventory changed');
  assert.equal(allFiles.filter(x => x.startsWith('examples/native-signup/')).length, 6);
  assert.equal(allFiles.filter(x => /^packages\/mcp\/src\/.*\.ts$/.test(x)).length, 12);
  const testFiles = allFiles.filter(x => /^packages\/mcp\/test\/[^/]+\.test\.mts$/.test(x)).sort();
  assert.equal(testFiles.length, 18);
  assert.equal(manifest.portableTests.length, 16);
  assert.deepEqual([...manifest.portableTests.map(x => x.file), ...manifest.retainedPublicTests.map(x => x.destination)].sort(), testFiles);
  for (const row of manifest.portableTests) assert.equal(sha256(bytes(root, row.file)), row.sha256);
  assert.equal(manifest.omitted.length, 1);
  const omitted = manifest.omitted[0];
  assert.equal(omitted.source, 'sdk/mcp/test/api-recovery.test.mts');
  assert.equal(omitted.sourceSha256, '42ff623318ae60d5c2127050c0e2045db0f5e8a8a4f8976c307261bc0fe50551');
  assert.equal(omitted.requiredMonorepoCi, true);
  assert.equal(manifest.monorepoCiGate.sourceRevision, MCP_REVISION);
  assert.equal(manifest.monorepoCiGate.requiredBeforePublication, true);
  assert.equal(manifest.monorepoCiGate.publicMirrorDoesNotRunPrivateApiIntegration, true);
  assert.equal(manifest.sharedFixture.destination, 'packages/holder/test/fixtures/native-claim-v1.json');
  assert.equal(manifest.sharedFixture.sha256, 'ab69675c2100ad01fbf8010e88ec5fe77fc19ca643103c2605e04dd9bc875d7c');
  assert.equal(sha256(bytes(root, manifest.sharedFixture.destination)), manifest.sharedFixture.sha256);
  const coreManifest = JSON.parse(bytes(root, 'sync-manifest.json'));
  assert.deepEqual(manifest.sharedDocumentationOverrides.map(x => x.current.destination).sort(), ['NATIVE-CLAIMS.md', 'README.md']);
  for (const override of manifest.sharedDocumentationOverrides) {
    const row = coreManifest.files.find(x => x.destination === override.current.destination);
    assert.deepEqual(row, override.current, 'Shared documentation override drift');
    assert.equal(row.sourceRevision, MCP_REVISION);
    assert.equal(sha256(bytes(root, row.destination)), row.destinationSha256);
    assert.equal(override.previous.destination, row.destination);
    assert.equal(override.previous.source, row.source);
  }
  const versions = { lookup: '0.11.0', owner: '0.12.0', holder: '0.10.0' };
  const metadata = JSON.parse(bytes(root, 'packages/mcp/package.json'));
  const lock = JSON.parse(bytes(root, 'packages/mcp/package-lock.json'));
  assert.equal(metadata.version, '0.10.0');
  assert.equal(metadata.engines.node, '>=22.12.0');
  assert.equal(metadata.scripts.test, 'node --import tsx --test test/*.test.mts');
  assert.deepEqual(metadata.files, ['dist']);
  assert.equal(lock.version, metadata.version);
  assert.equal(lock.packages[''].version, metadata.version);
  const native = JSON.parse(bytes(root, 'examples/native-signup/package.json'));
  const nativeLock = JSON.parse(bytes(root, 'examples/native-signup/package-lock.json'));
  assert.equal(native.private, true);
  for (const [pkg, version] of Object.entries(versions)) {
    const name = '@sorandomains/' + pkg, key = 'node_modules/' + name;
    assert.equal(metadata.dependencies[name], version);
    assert.equal(lock.packages[''].dependencies[name], version);
    const entry = lock.packages[key];
    assert.equal(entry.version, version);
    assert.equal(entry.resolved, `https://registry.npmjs.org/${name}/-/${pkg}-${version}.tgz`);
    assert.deepEqual(manifest.coreDependencies[key], { version, integrity: entry.integrity });
    if (pkg !== 'owner') {
      assert.equal(native.dependencies[name], version);
      assert.equal(nativeLock.packages[''].dependencies[name], version);
      assert.equal(nativeLock.packages[key].version, version);
      assert.equal(nativeLock.packages[key].integrity, entry.integrity);
      assert.equal(nativeLock.packages[key].resolved, entry.resolved);
    }
  }
  const tests = JSON.parse(bytes(root, 'test-manifest.json'));
  assert.equal(tests.sourceRevisions.mcp, MCP_REVISION);
  assert.deepEqual(tests.retainedPublicTests, manifest.retainedPublicTests);
  const gate = tests.monorepoOnly.find(x => x.source === omitted.source);
  assert.equal(gate.sourceSha256, omitted.sourceSha256);
  assert.equal(gate.requiredMonorepoCi, true);
  assert.equal(gate.claimedAsPublicCi, false);
  return { sourceRevision: MCP_REVISION, coreSourceRevision: SOURCE_REVISION, mappedFiles: seen.size, portableMcpTestFiles: testFiles.length, omittedPrivateTestFiles: 1, productionSourceByteIdentical: true };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(JSON.stringify(verifyMcpSync(path.resolve(fileURLToPath(new URL('../', import.meta.url)))), null, 2));
