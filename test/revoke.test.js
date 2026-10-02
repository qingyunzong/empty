import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdirPath, mulberry32, shuffle } from '../testlib/helpers.js';
import { appendToLog, readJsonl } from '../lib/store.js';
import { verify } from '../lib/verify.js';

// Acceptance 2: revoke-of-revoke boundary is deterministic.
// r2 at an EQUAL epoch cannot cancel r1; r3 at a HIGHER epoch can.
test('revoke of revoke requires strictly higher epoch, order-independent', () => {
  const dir = tmpdirPath();
  const log = join(dir, 'qa.jsonl');

  const s1 = appendToLog(log, { site: 'QA', epoch: 1, type: 'step', payload: { step: 'fill' } });
  const r1 = appendToLog(log, { site: 'QA', epoch: 1, type: 'revoke', target: s1.hash, scope: 'record' });
  // Equal epoch: inert, s1 stays shadowed.
  const r2 = appendToLog(log, { site: 'QA', epoch: 1, type: 'revoke', target: r1.hash, scope: 'record' });

  let cert = verify(readJsonl(log));
  assert.deepEqual(cert.shadowed, [s1.hash], 'equal-epoch revoke of a revoke is inert');
  assert.equal(cert.status, 'ok');

  // Higher epoch: cancels r1, s1 auditable again, r1 itself shadowed.
  const r3 = appendToLog(log, { site: 'QA', epoch: 2, type: 'revoke', target: r1.hash, scope: 'record' });
  cert = verify(readJsonl(log));
  assert.deepEqual(cert.shadowed, [r1.hash], 'higher-epoch revoke cancels r1 and shadows it');
  assert.ok(!cert.shadowed.includes(s1.hash), 'original step unshadowed but still in the log');
  assert.equal(cert.count, 4, 'tombstones never remove history');

  // Determinism: any input permutation yields the same shadowed set and head.
  const all = readJsonl(log);
  const rand = mulberry32(7);
  for (let i = 0; i < 10; i++) {
    const c = verify(shuffle(all, rand));
    assert.deepEqual(c.shadowed, [r1.hash]);
    assert.equal(c.head, cert.head);
  }
});

test('revoke targets a deviation; missing target is reported, not an error', () => {
  const dir = tmpdirPath();
  const log = join(dir, 'm.jsonl');
  const d1 = appendToLog(log, { site: 'M', epoch: 1, type: 'deviation', payload: { dev: 'stop' } });
  appendToLog(log, { site: 'M', epoch: 1, type: 'revoke', target: d1.hash, scope: 'record' });
  appendToLog(log, { site: 'M', epoch: 1, type: 'revoke', target: 'f'.repeat(64), scope: 'record' });
  const cert = verify(readJsonl(log));
  assert.deepEqual(cert.shadowed, [d1.hash]);
  assert.deepEqual(cert.missing, [{ kind: 'target', hash: 'f'.repeat(64) }]);
  assert.equal(cert.status, 'unknown', 'missing revoke target => unknown, never failure');
});
