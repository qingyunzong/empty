import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyRecords, makeRecord } from '../src/index.js';
import { siteLog } from './helpers.js';

test('acceptance 3: missing records yield unknown status with gap list, never failure', () => {
  const log = siteLog('S1', 1, 5);
  const dropped = log[2]; // counter 3
  const partial = log.filter((r) => r.hash !== dropped.hash);

  const { exitCode, certificate } = verifyRecords(partial);
  assert.equal(exitCode, 0, 'missing data must not fail verification');
  assert.equal(certificate.status, 'unknown');
  assert.ok(certificate.missing.length > 0);

  const kinds = certificate.missing.map((m) => m.kind);
  assert.ok(kinds.includes('prev'), 'gap reported via dangling prev hash');
  assert.ok(kinds.includes('counters'), 'gap reported via counter range');
  const counterGap = certificate.missing.find((m) => m.kind === 'counters');
  assert.deepEqual({ from: counterGap.from, to: counterGap.to }, { from: 3, to: 3 });
  const prevGap = certificate.missing.find((m) => m.kind === 'prev');
  assert.equal(prevGap.prev, dropped.hash);

  // certificate still carries head and auditable sets
  assert.equal(typeof certificate.head, 'string');
  assert.deepEqual(certificate.masked, []);
});

test('missing tail of one site seen through another site vector clock stays unknown', () => {
  const s1 = siteLog('S1', 1, 2);
  const s2 = siteLog('S2', 1, 2);
  // S2's second record causally saw S1 counter 2, but we drop S1's second record
  const patched = makeRecord({
    type: s2[1].type, site: s2[1].site, gen: s2[1].gen,
    vc: { ...s2[1].vc, S1: 2 }, prev: s2[1].prev, payload: s2[1].payload,
  });
  const merged = [s1[0], s2[0], patched];
  const { exitCode, certificate } = verifyRecords(merged);
  assert.equal(exitCode, 0);
  assert.equal(certificate.status, 'unknown');
  const causal = certificate.missing.find((m) => m.kind === 'causal');
  assert.deepEqual({ site: causal.site, from: causal.from, to: causal.to }, { site: 'S1', from: 2, to: 2 });
});
