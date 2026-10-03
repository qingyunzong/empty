import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AlarmIndex } from '../src/index.js';
import { hashCert } from '../src/cert.js';
import { CORPUS } from './helpers.js';

function buildIndex() {
  const idx = new AlarmIndex();
  for (const doc of CORPUS) idx.addDocument(doc.id, doc.text);
  return idx;
}

test('compact issues certificate with term count, deletion count, root hash', () => {
  const idx = buildIndex();
  const cert = idx.compact();
  assert.equal(cert.seq, 0);
  assert.equal(cert.termCount, idx.dictionary.length);
  assert.ok(cert.termCount > 0);
  assert.equal(cert.deletionCount, 0);
  assert.equal(cert.prevHash, null);
  assert.match(cert.rootHash, /^[0-9a-f]{64}$/);
  assert.ok(idx.verifyCert());
});

test('deletion + compact changes certificate; old cert still proves history', () => {
  const idx = buildIndex();
  const cert1 = idx.compact();
  idx.deleteDocument('m6');
  const cert2 = idx.compact();

  assert.notEqual(cert2.rootHash, cert1.rootHash); // certificate changed
  assert.equal(cert2.deletionCount, 1);
  assert.equal(cert2.termCount, cert1.termCount - 2); // m6 holds the only occurrences of 原因码c104 and 处理码t204
  assert.equal(cert2.prevHash, hashCert(cert1)); // old cert committed in chain
  assert.ok(idx.verifyCert());
  // the old certificate itself is immutable and still hashes to the same value
  assert.equal(hashCert(cert1), cert2.prevHash);
});

test('certificates survive save/load round-trip', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alarm-cert-'));
  const idx = buildIndex();
  idx.deleteDocument('m6');
  idx.compact();
  idx.save(dir);
  const loaded = AlarmIndex.load(dir);
  assert.ok(loaded.verifyCert());
  assert.deepEqual(loaded.certs, idx.certs);
});

test('tampering with the chain raises E_CERT', () => {
  const idx = buildIndex();
  idx.compact();
  idx.deleteDocument('m3');
  idx.compact();
  idx.certs[1].deletionCount = 99; // forged certificate
  assert.throws(() => idx.verifyCert(), (err) => err.code === 'E_CERT');
});

test('tampering with postings raises E_CERT', () => {
  const idx = buildIndex();
  idx.compact();
  idx.addDocument('injected', '泵 气蚀 注入'); // index no longer matches cert
  assert.throws(() => idx.verifyCert(), (err) => err.code === 'E_CERT');
});

test('verifyCert before any compact raises E_CERT', () => {
  const idx = buildIndex();
  assert.throws(() => idx.verifyCert(), (err) => err.code === 'E_CERT');
});
