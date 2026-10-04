import test from 'node:test';
import assert from 'node:assert/strict';
import { ClearingEngine } from '../src/engine.js';
import { generateEvents, bruteForceNets, trackEverSeen } from './helpers.js';

const submit = (id, version, payer, payee, amountCents, dependsOn) => ({
  type: 'submit',
  id,
  version,
  payer,
  payee,
  amountCents,
  ...(dependsOn ? { dependsOn } : {}),
});

test('submit nets two institutions and issues a certificate', () => {
  const engine = new ClearingEngine();
  const r = engine.apply(submit('i1', 1, 'A', 'B', 500));
  assert.equal(r.nets.A, -500);
  assert.equal(r.nets.B, 500);
  assert.equal(r.batchSeq, 1);
  assert.match(r.certificate, /^[0-9a-f]{64}$/);
});

test('revoke creates a reversing entry, retains the original hash, restore brings nets back', () => {
  const engine = new ClearingEngine();
  engine.apply(submit('i1', 1, 'A', 'B', 500));
  const originalHash = engine.instrs.get('i1').hash;

  const revoked = engine.apply({ type: 'revoke', id: 'i1' });
  assert.equal(revoked.nets.A, 0);
  assert.equal(revoked.nets.B, 0);

  const post = engine.entries.find((e) => e.kind === 'post');
  const reversal = engine.entries.find((e) => e.kind === 'reversal');
  assert.equal(post.instrHash, originalHash);
  assert.equal(reversal.reverseOf, originalHash);
  assert.equal(engine.instrs.get('i1').hash, originalHash, 'original hash retained');

  const restored = engine.apply(submit('i1', 2, 'A', 'B', 500));
  assert.equal(restored.nets.A, -500);
  assert.equal(restored.nets.B, 500);
  assert.equal(engine.entries.filter((e) => e.kind === 'post').length, 2);
  assert.equal(restored.batchSeq, 3);
});

test('resubmission is idempotent by version', () => {
  const engine = new ClearingEngine();
  engine.apply(submit('i1', 1, 'A', 'B', 500));
  const dup = engine.apply(submit('i1', 1, 'A', 'B', 500));
  assert.equal(dup.changed, false);
  assert.equal(dup.batchSeq, 1);
  const stale = engine.apply(submit('i1', 0 + 1, 'A', 'B', 500));
  assert.equal(stale.changed, false);
  assert.throws(() => engine.apply(submit('i1', 1, 'A', 'B', 999)), (err) => err.code === 'CONFLICT');
});

test('replace with higher version reverses the old contribution', () => {
  const engine = new ClearingEngine();
  engine.apply(submit('i1', 1, 'A', 'B', 500));
  const r = engine.apply(submit('i1', 2, 'B', 'A', 200));
  assert.equal(r.nets.A, 200);
  assert.equal(r.nets.B, -200);
  const reversal = engine.entries.find((e) => e.kind === 'reversal');
  assert.equal(reversal.version, 1);
});

test('cyclic dependencies are rejected', () => {
  const engine = new ClearingEngine();
  engine.apply(submit('a', 1, 'A', 'B', 10));
  engine.apply(submit('b', 1, 'B', 'C', 10, ['a']));
  engine.apply(submit('c', 1, 'C', 'D', 10, ['b']));
  assert.throws(
    () => engine.apply(submit('a', 2, 'A', 'B', 10, ['c'])),
    (err) => err.code === 'CYCLE',
  );
  assert.throws(
    () => engine.apply(submit('a', 2, 'A', 'B', 10, ['a'])),
    (err) => err.code === 'CYCLE',
  );
  assert.throws(
    () => engine.apply(submit('d', 1, 'A', 'B', 10, ['nope'])),
    (err) => err.code === 'UNKNOWN_DEPENDENCY',
  );
});

test('revoking an instruction removes its dependency edges (dynamic topology)', () => {
  const engine = new ClearingEngine();
  engine.apply(submit('a', 1, 'A', 'B', 10));
  engine.apply(submit('b', 1, 'B', 'C', 10, ['a']));
  assert.equal(engine.graph.hasEdge('instr:a', 'instr:b'), true);
  engine.apply({ type: 'revoke', id: 'b' });
  assert.equal(engine.graph.hasEdge('instr:a', 'instr:b'), false);
});

test('overflow and invalid amounts are errors', () => {
  const engine = new ClearingEngine();
  engine.apply(submit('big', 1, 'A', 'B', Number.MAX_SAFE_INTEGER));
  assert.throws(
    () => engine.apply(submit('big2', 1, 'A', 'B', 1)),
    (err) => err.code === 'OVERFLOW',
  );
  const fresh = new ClearingEngine();
  for (const bad of [1.5, 0, -7, Number.MAX_SAFE_INTEGER + 1, '100']) {
    assert.throws(
      () => fresh.apply(submit('x', 1, 'A', 'B', bad)),
      (err) => err.code === 'INVALID_AMOUNT' || err.code === 'OVERFLOW',
    );
  }
});

test('invalidation propagates only to affected balances and the batch', () => {
  const engine = new ClearingEngine();
  engine.apply(submit('i1', 1, 'A', 'B', 100));
  engine.apply(submit('i2', 1, 'C', 'D', 50));
  const r = engine.apply({ type: 'revoke', id: 'i1' });
  assert.ok(r.invalidated.includes('bal:A'));
  assert.ok(r.invalidated.includes('bal:B'));
  assert.ok(r.invalidated.includes('batch'));
  assert.ok(!r.invalidated.includes('bal:C'));
  assert.ok(!r.invalidated.includes('bal:D'));
});

test('randomized: incremental matches naive full recompute and brute force', () => {
  const { events, model } = generateEvents(0xc1ea, 400);
  const everSeen = trackEverSeen(events);
  const incremental = new ClearingEngine();
  const naive = new ClearingEngine({ naive: true });
  for (let i = 0; i < events.length; i++) {
    const r1 = incremental.apply(events[i]);
    const r2 = naive.apply(events[i]);
    assert.deepEqual(r1.nets, r2.nets, `nets diverge at event ${i}`);
    assert.equal(r1.certificate, r2.certificate, `certificate diverges at event ${i}`);
    assert.equal(r1.changed, r2.changed, `changed flag diverges at event ${i}`);
  }
  assert.deepEqual(incremental.nets(), bruteForceNets(model, everSeen));
});

test('deterministic: identical event streams produce identical certificates', () => {
  const { events } = generateEvents(7, 150);
  const first = new ClearingEngine();
  const second = new ClearingEngine();
  for (const event of events) {
    const r1 = first.apply(event);
    const r2 = second.apply(event);
    assert.equal(r1.certificate, r2.certificate);
  }
  const replayed = ClearingEngine.recomputeAll(events);
  assert.equal(replayed.certificate, first.certificate);
  assert.deepEqual(replayed.nets, first.nets());
});

test('snapshot/restore round-trip continues identically', () => {
  const { events } = generateEvents(99, 200);
  const live = new ClearingEngine();
  let restored = null;
  for (let i = 0; i < events.length; i++) {
    const expected = live.apply(events[i]);
    if (i === 99) restored = ClearingEngine.restore(live.snapshot());
    if (i >= 100) {
      const actual = restored.apply(events[i]);
      assert.equal(actual.certificate, expected.certificate, `diverges at event ${i}`);
      assert.deepEqual(actual.nets, expected.nets);
    }
  }
});
