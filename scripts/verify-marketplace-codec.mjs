import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

// Hashes from @sorandomains/lookup@0.12.0 on npm. Each marketplace SDK builds
// its own copy from reviewed source, with the compiler pinned in its lockfile.
const expected = {
  'dist/payment.js': 'c54ecb3042708238abb1ec90a6cbeb000652915896ef34b4de3447d1d04e668d',
  'dist/payment.d.ts': '1fee9d702f1bc0685c60498a0eef6a30aa3f21025cd49cfc8a1f2dd29057265f',
};
for (const [file, digest] of Object.entries(expected)) {
  const compiled = createHash('sha256').update(readFileSync(file)).digest('hex');
  assert.equal(compiled, digest, `${file} differs from published Lookup 0.12.0`);
}
