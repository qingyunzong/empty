// Reference test: independently canonicalize the enumerated WAL records and
// recompute every hash, without importing the library's canonical/hash code.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Store, WAL_FILE, GENESIS_HASH } from '../src/store.js';

// Independent canonicalization: sorted keys, no whitespace, recursive.
function canon(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return '[' + value.map(canon).join(',') + ']';
  if (typeof value === 'object') {
    return (
      '{' +
      Object.keys(value)
        .sort()
        .map((k) => JSON.stringify(k) + ':' + canon(value[k]))
        .join(',') +
      '}'
    );
  }
  return JSON.stringify(value);
}

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

test('reference: independently re-canonicalize records and recompute hash chain', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'settle-audit-ref-'));
  const store = Store.open(dir);
  const certs = [];
  certs.push(await store.commit({ type: 'payment', id: 'p1', party: 'carol', amount: 10, currency: 'CNY' }));
  certs.push(await store.commit({ type: 'settlement', id: 's1', party: 'carol', amount: -4, currency: 'CNY' }));
  certs.push(await store.commit({ type: 'payment', id: 'p2', party: 'dan', amount: 7, currency: 'CNY' }));
  certs.push(await store.commit({ type: 'reversal', ref: 'p1' }));
  store.close();

  const lines = fs.readFileSync(path.join(dir, WAL_FILE), 'utf8').split('\n').filter(Boolean);
  assert.equal(lines.length, 4);

  let prevHash = GENESIS_HASH;
  lines.forEach((line, index) => {
    const rec = JSON.parse(line);
    const seq = index + 1;

    // Enumerated record fields, independently re-canonicalized.
    assert.equal(rec.seq, seq);
    assert.equal(rec.version, seq);
    assert.equal(rec.parentVersion, seq - 1);
    assert.equal(rec.snapshotVersion, seq - 1);

    // Recompute op hash from the canonical op encoding.
    assert.equal(rec.opHash, sha256(canon(rec.op)), `opHash mismatch at seq ${seq}`);

    // Recompute certificate digest from its five fields.
    const certBody = {
      version: rec.version,
      parentVersion: rec.parentVersion,
      snapshotVersion: rec.snapshotVersion,
      opHash: rec.opHash,
      prevHash: rec.prevHash,
    };
    assert.equal(rec.prevHash, prevHash, `chain broken at seq ${seq}`);
    assert.equal(rec.digest, sha256(canon(certBody)), `digest mismatch at seq ${seq}`);

    // Cross-check against the certificate returned at commit time.
    assert.equal(rec.digest, certs[index].digest);
    assert.equal(rec.opHash, certs[index].opHash);

    prevHash = rec.digest;
  });
});
