import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SOURCE_REVISION = 'cec2d29bd392c64ac3e7f8d1d20d626736c72ce5';
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const safe = value => typeof value === 'string' && /^(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+$/.test(value) && !value.split('/').some(x => x === '.' || x === '..');
const managed = ['packages/lookup/', 'packages/owner/', 'packages/holder/', 'examples/hint-server/', 'examples/hint-server-cloudflare/'];
function listedFiles(root, relative) {
  return fs.readdirSync(path.join(root, relative), { withFileTypes: true }).flatMap(entry => {
    if (['node_modules', 'dist', '.DS_Store'].includes(entry.name) || entry.name.endsWith('.log')) return [];
    const item = relative + entry.name;
    assert(!entry.isSymbolicLink(), `Unexpected symlink: ${item}`);
    return entry.isDirectory() ? listedFiles(root, item + '/') : [item];
  });
}
export function verifySync(root) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'sync-manifest.json'), 'utf8'));
  assert.equal(manifest.format, 'soran-public-sdk-sync-v1');
  assert.equal(manifest.sourceRevision, SOURCE_REVISION);
  assert.equal(manifest.productionSourcesUnchanged, true);
  const seen = new Set();
  for (const row of manifest.files) {
    assert(safe(row.source) && safe(row.destination), 'Unsafe mapping path');
    assert(!seen.has(row.destination), `Duplicate mapping: ${row.destination}`);
    seen.add(row.destination);
    assert(/^[a-f0-9]{64}$/.test(row.sourceSha256) && /^[a-f0-9]{64}$/.test(row.destinationSha256));
    const target = path.join(root, row.destination);
    assert(fs.lstatSync(target).isFile() && !fs.lstatSync(target).isSymbolicLink());
    assert.equal(sha256(fs.readFileSync(target)), row.destinationSha256, `Export drift: ${row.destination}`);
    if (/^packages\/(lookup|owner|holder)\/src\//.test(row.destination)) {
      assert(row.exact, `Production source was transformed: ${row.destination}`);
      assert.equal(row.sourceSha256, row.destinationSha256);
    }
  }
  for (const prefix of managed) for (const file of listedFiles(root, prefix)) assert(seen.has(file), `Unmapped managed file: ${file}`);
  for (const fixture of manifest.generatedFixtures) {
    assert(safe(fixture.file));
    assert.equal(sha256(fs.readFileSync(path.join(root, fixture.file))), fixture.sha256, `Fixture drift: ${fixture.file}`);
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, fixture.file))).sourceRevision, SOURCE_REVISION);
  }
  const abi = JSON.parse(fs.readFileSync(path.join(root, 'fixtures/public-abi-errors.json')));
  assert.deepEqual(Object.keys(abi.contracts).sort(), ['funding', 'lookup', 'primary', 'registrar', 'registry', 'resolver']);
  for (const [name, row] of Object.entries(abi.contracts)) {
    assert.equal(row.sourcePath, `contracts/${name}/src/lib.rs`);
    assert(/^[a-f0-9]{64}$/.test(row.sourceSha256));
    assert(Object.keys(row.errors).length > 0);
    for (const [code, variant] of Object.entries(row.errors)) assert(/^[1-9][0-9]*$/.test(code) && /^[A-Za-z][A-Za-z0-9]*$/.test(variant));
  }
  const versions = { lookup: '0.11.0', owner: '0.12.0', holder: '0.10.0' };
  for (const [pkg, version] of Object.entries(versions)) {
    const metadata = JSON.parse(fs.readFileSync(path.join(root, 'packages', pkg, 'package.json')));
    const lock = JSON.parse(fs.readFileSync(path.join(root, 'packages', pkg, 'package-lock.json')));
    assert.equal(metadata.version, version);
    assert.equal(lock.version, version);
    assert.equal(lock.packages[''].version, version);
    assert.deepEqual(metadata.repository, { type: 'git', url: 'git+https://github.com/SoranDomains/sdk.git', directory: `packages/${pkg}` });
  }
  return { sourceRevision: SOURCE_REVISION, mappedFiles: seen.size, generatedFixtures: manifest.generatedFixtures.length, productionSourcesUnchanged: true };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(JSON.stringify(verifySync(path.resolve(fileURLToPath(new URL('../', import.meta.url)))), null, 2));
