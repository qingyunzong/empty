import test from 'node:test';
import assert from 'node:assert/strict';
import { cli, tmpdir, initPair, expectOk } from './helpers.js';

function concurrentMoveScenario(root) {
  const { a, b } = initPair(root);
  expectOk(cli(['apply', '--dir', a, '--change', '{"type":"move","op":"J2.o2","machine":"M1","index":3}']));
  expectOk(cli(['apply', '--dir', b, '--change', '{"type":"move","op":"J2.o2","machine":"M2","index":0}']));
  return { a, b };
}

test('concurrent moves of the same op: deterministic winner, loser pending, exit 3', () => {
  const root = tmpdir();
  const { a, b } = concurrentMoveScenario(root);
  const sync = cli(['sync', '--a', a, '--b', b]);
  assert.equal(sync.code, 3, sync.stderr);
  const summary = sync.json();
  assert.equal(summary.pending.length, 1);
  const p = summary.pending[0];
  assert.equal(p.op, 'J2.o2');
  assert.equal(p.reason, 'concurrent-move');
  assert.equal(p.winner.node, 'B', 'deterministic rule: higher node id wins move-vs-move');
  assert.equal(p.loser.node, 'A');

  const cert = JSON.parse(expectOk(cli(['export-cert', '--dir', a])).stdout);
  assert.equal(cert.schedule.M2[0], 'J2.o2', 'winner placement is applied');
  assert.equal(cert.pending.length, 1);

  const verify = cli(['verify', '--dir', a]);
  assert.equal(verify.code, 3, 'pending conflicts are not unsatisfiable: exit 3, not 2');
  assert.equal(verify.json().valid, true, 'no constraint violation may be reported for pending items');
});

test('certificate is reproducible across independent runs and sync orders', () => {
  const certs = [];
  for (const swap of [false, true]) {
    const root = tmpdir();
    const { a, b } = concurrentMoveScenario(root);
    const s = swap ? cli(['sync', '--a', b, '--b', a]) : cli(['sync', '--a', a, '--b', b]);
    assert.equal(s.code, 3);
    certs.push(expectOk(cli(['export-cert', '--dir', a])).stdout);
  }
  assert.equal(certs[0], certs[1]);
});

test('a dominating later change clears the pending item', () => {
  const root = tmpdir();
  const { a, b } = concurrentMoveScenario(root);
  assert.equal(cli(['sync', '--a', a, '--b', b]).code, 3);
  expectOk(cli(['apply', '--dir', a, '--change', '{"type":"move","op":"J2.o2","machine":"M1","index":3}']));
  const sync = cli(['sync', '--a', a, '--b', b]);
  assert.equal(sync.code, 0, sync.stderr);
  assert.equal(sync.json().pending.length, 0);
});

test('cancel beats concurrent move by deterministic rule', () => {
  const root = tmpdir();
  const { a, b } = initPair(root);
  expectOk(cli(['apply', '--dir', a, '--change', '{"type":"cancel","op":"J2.o2"}']));
  expectOk(cli(['apply', '--dir', b, '--change', '{"type":"move","op":"J2.o2","machine":"M1","index":3}']));
  const sync = cli(['sync', '--a', a, '--b', b]);
  assert.equal(sync.code, 3, sync.stderr);
  const cert = JSON.parse(expectOk(cli(['export-cert', '--dir', a])).stdout);
  assert.ok(!cert.schedule.M1.includes('J2.o2') && !cert.schedule.M2.includes('J2.o2'), 'cancel wins');
  assert.equal(cert.pending[0].winner.type, 'cancel');
});
