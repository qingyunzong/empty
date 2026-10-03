import test from 'node:test';
import assert from 'node:assert/strict';
import { dedupeByHash, canonicalOrder, chainHead, verifyRecords } from '../src/index.js';
import { siteLog, shuffle, mulberry32 } from './helpers.js';

test('acceptance 1: three-site out-of-order merge is replayable', () => {
  const a = siteLog('ALPHA', 1, 3);
  const b = siteLog('BETA', 1, 2);
  const c = siteLog('GAMMA', 1, 4);
  const all = [...a, ...b, ...c];
  const rand = mulberry32(42);

  const referenceOrder = canonicalOrder(dedupeByHash(all)).map((r) => r.hash);
  const referenceHead = chainHead(dedupeByHash(all));

  for (let trial = 0; trial < 25; trial += 1) {
    const shuffled = shuffle(all, rand);
    const merged = dedupeByHash(shuffled);
    assert.deepEqual(canonicalOrder(merged).map((r) => r.hash), referenceOrder);
    assert.equal(chainHead(merged), referenceHead);
    const { exitCode, certificate } = verifyRecords(merged);
    assert.equal(exitCode, 0);
    assert.equal(certificate.status, 'ok');
    assert.deepEqual(certificate.missing, []);
    assert.equal(certificate.head, referenceHead);
    assert.deepEqual(certificate.sites, ['ALPHA', 'BETA', 'GAMMA']);
  }

  // replay: records fed one-by-one in canonical order reproduce the same head
  const replayed = [];
  for (const hash of referenceOrder) {
    replayed.push(all.find((r) => r.hash === hash));
  }
  assert.equal(chainHead(replayed), referenceHead);
});
