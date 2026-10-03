import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { cli, tmpdir, initPair, expectOk } from './helpers.js';

test('bidirectional convergence: both terminals reach identical state and cert', () => {
  const root = tmpdir();
  const { a, b } = initPair(root);

  expectOk(cli(['apply', '--dir', a, '--change', '{"type":"move","op":"J2.o1","machine":"M2","index":0}']));
  expectOk(cli(['apply', '--dir', b, '--change', '{"type":"move","op":"J2.o2","machine":"M1","index":3}']));
  expectOk(cli(['apply', '--dir', b, '--change', '{"type":"insert","op":{"id":"J2.o3","job":"J2","cap":"paint","dur":2},"machine":"M2","index":2}']));
  expectOk(cli(['apply', '--dir', a, '--change', '{"type":"cancel","op":"J1.o3"}']));

  const sync = cli(['sync', '--a', a, '--b', b]);
  assert.equal(sync.code, 0, sync.stderr);
  const summary = sync.json();
  assert.equal(summary.converged, true);
  assert.deepEqual(summary.clock, { A: 2, B: 2 });
  assert.equal(summary.pending.length, 0);

  const certA = expectOk(cli(['export-cert', '--dir', a])).stdout;
  const certB = expectOk(cli(['export-cert', '--dir', b])).stdout;
  assert.equal(certA, certB);

  const cert = JSON.parse(certA);
  assert.equal(cert.schedule.M2[0], 'J2.o1', 'moved op lands at the requested index');
  assert.ok(!cert.schedule.M1.includes('J1.o3') && !cert.schedule.M2.includes('J1.o3'), 'cancelled op must be gone');
  assert.ok(cert.schedule.M2.includes('J2.o3'), 'inserted op must be present');
  assert.ok(cert.schedule.M1.includes('J2.o2'), 'remote move must be replicated');
  assert.equal(cert.clock.A, 2);
  assert.equal(cert.clock.B, 2);

  assert.equal(cli(['verify', '--dir', a]).code, 0);
  assert.equal(cli(['verify', '--dir', b]).code, 0);
});

test('sync is order-independent: sync(A,B) and sync(B,A) produce the same certificate', () => {
  const run = (swap) => {
    const root = tmpdir();
    const { a, b } = initPair(root);
    expectOk(cli(['apply', '--dir', a, '--change', '{"type":"move","op":"J2.o1","machine":"M2","index":0}']));
    expectOk(cli(['apply', '--dir', b, '--change', '{"type":"move","op":"J1.o3","machine":"M1","index":3}']));
    const s = swap ? cli(['sync', '--a', b, '--b', a]) : cli(['sync', '--a', a, '--b', b]);
    assert.equal(s.code, 0, s.stderr);
    return expectOk(cli(['export-cert', '--dir', a])).stdout;
  };
  assert.equal(run(false), run(true));
});

test('repeated sync is idempotent', () => {
  const root = tmpdir();
  const { a, b } = initPair(root);
  expectOk(cli(['apply', '--dir', a, '--change', '{"type":"move","op":"J2.o1","machine":"M2","index":0}']));
  assert.equal(cli(['sync', '--a', a, '--b', b]).code, 0);
  const first = expectOk(cli(['export-cert', '--dir', a])).stdout;
  assert.equal(cli(['sync', '--a', a, '--b', b]).code, 0);
  const second = expectOk(cli(['export-cert', '--dir', a])).stdout;
  assert.equal(first, second);
});
