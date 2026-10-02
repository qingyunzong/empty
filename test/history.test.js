import test from 'node:test';
import assert from 'node:assert/strict';
import { CausalHistory, correctedInterval } from '../src/history.js';
import { Frac } from '../src/rational.js';

const F = (s) => Frac.parse(s);

test('vertex inside interval is included, outside is ignored', () => {
  // f(t) = t^2 - 4t on [0, 4]: vertex t*=2, f=-4; endpoints 0, 0.
  const inIv = correctedInterval(F('0'), F('4'), F('0'), F('-4'), F('1'));
  assert.equal(inIv.lo.toString(), '-4');
  assert.equal(inIv.hi.toString(), '0');
  assert.equal(inIv.vertex.t.toString(), '2');
  // Same parabola on [5, 6]: vertex outside, endpoints only.
  const outIv = correctedInterval(F('5'), F('6'), F('0'), F('-4'), F('1'));
  assert.equal(outIv.vertex, null);
  assert.equal(outIv.lo.toString(), '5');
  assert.equal(outIv.hi.toString(), '12');
});

test('acceptance 1: linear correction, overlapping events enumerate both orders', () => {
  const h = new CausalHistory();
  h.addEvent({ id: 'e1', a: 0, b: 10, f: [0, 1, 0] });
  h.addEvent({ id: 'e2', a: 5, b: 15, f: [0, 1, 0] });
  const q = h.relation('e1', 'e2');
  assert.equal(q.relation, 'concurrent');
  assert.equal(q.certificate.kind, 'overlap');
  assert.equal(q.certificate.overlap.lo, '5');
  assert.equal(q.certificate.overlap.hi, '10');
  const lin = h.linearizations();
  assert.equal(lin.count, 2);
  assert.deepEqual(lin.linearizations, [['e1', 'e2'], ['e2', 'e1']]);
});

test('acceptance 2: quadratic vertex makes definite ordering hold', () => {
  const h = new CausalHistory();
  // f(t) = t^2 - 4t + 10 on [0,4]: endpoints 10, vertex v(2)=6 -> [6,10].
  h.addEvent({ id: 'e1', a: 0, b: 4, f: ['10', '-4', '1'] });
  // identity on [0,5] -> [0,5]; 5 < 6 only because the vertex is counted.
  h.addEvent({ id: 'e2', a: 0, b: 5, f: [0, 1, 0] });
  const d1 = h.describeEvent('e1');
  assert.equal(d1.lo, '6');
  assert.equal(d1.vertex.v, '6');
  const q = h.relation('e2', 'e1');
  assert.equal(q.relation, 'before');
  assert.equal(q.certificate.kind, 'interval');
  assert.equal(q.certificate.events.x.hi, '5');
  assert.equal(q.certificate.events.y.lo, '6');
  assert.equal(q.certificate.events.y.vertex.t, '2');
  const lin = h.linearizations();
  assert.deepEqual(lin.linearizations, [['e2', 'e1']]);
});

test('acceptance 3: undo of a correction restores possible concurrency', () => {
  const h = new CausalHistory();
  h.addEvent({ id: 'e1', a: 0, b: 10, f: [0, 1, 0] });
  h.addEvent({ id: 'e2', a: 5, b: 15, f: [0, 1, 0] });
  assert.equal(h.relation('e1', 'e2').relation, 'concurrent');
  // Shift e1 fully into the past: f(t) = t - 20 -> [-20, -10] < [5, 15].
  h.correct({ id: 'e1', f: ['-20', 1, 0] });
  assert.equal(h.relation('e1', 'e2').relation, 'before');
  h.undo();
  assert.equal(h.relation('e1', 'e2').relation, 'concurrent');
  h.redo();
  assert.equal(h.relation('e1', 'e2').relation, 'before');
});

test('acceptance 4: contradictory constraints return E_UNSAT', () => {
  const h = new CausalHistory();
  h.addEvent({ id: 'e1', a: 0, b: 10, f: [0, 1, 0] });
  h.addEvent({ id: 'e2', a: 0, b: 10, f: [0, 1, 0] });
  h.addConstraint({ before: 'e1', after: 'e2' });
  h.addConstraint({ before: 'e2', after: 'e1' });
  assert.throws(() => h.linearizations(), (e) => e.code === 'E_UNSAT');
  assert.throws(() => h.relation('e1', 'e2'), (e) => e.code === 'E_UNSAT');
});

test('constraint chain forces ordering and yields chain certificate', () => {
  const h = new CausalHistory();
  for (const id of ['a', 'b', 'c']) {
    h.addEvent({ id, a: 0, b: 100, f: [0, 1, 0] });
  }
  h.addConstraint({ before: 'a', after: 'b' });
  h.addConstraint({ before: 'b', after: 'c' });
  const q = h.relation('a', 'c');
  assert.equal(q.relation, 'before');
  assert.equal(q.certificate.kind, 'chain');
  assert.deepEqual(
    q.certificate.chain.map((s) => [s.type, s.from, s.to]),
    [['constraint', 'a', 'b'], ['constraint', 'b', 'c']],
  );
  const lin = h.linearizations();
  assert.deepEqual(lin.linearizations, [['a', 'b', 'c']]);
});

test('invalid polynomial does not change history', () => {
  const h = new CausalHistory();
  h.addEvent({ id: 'e1', a: 0, b: 10, f: [0, 1, 0] });
  assert.throws(() => h.correct({ id: 'e1', f: ['1/0', 1, 0] }), (e) => e.code === 'E_RATIONAL');
  assert.throws(() => h.correct({ id: 'e1', f: [1, 2] }), (e) => e.code === 'E_RATIONAL');
  assert.equal(h.describeEvent('e1').lo, '0');
  assert.equal(h.describeEvent('e1').hi, '10');
});

test('a > b returns E_RANGE', () => {
  const h = new CausalHistory();
  assert.throws(() => h.addEvent({ id: 'e1', a: 5, b: 2, f: [0, 1, 0] }), (e) => e.code === 'E_RANGE');
});

test('undo/redo across add_event and constraint ops', () => {
  const h = new CausalHistory();
  h.addEvent({ id: 'e1', a: 0, b: 1, f: [0, 1, 0] });
  h.addEvent({ id: 'e2', a: 0, b: 1, f: [0, 1, 0] });
  h.addConstraint({ before: 'e1', after: 'e2' });
  assert.equal(h.linearizations().count, 1);
  h.undo();
  assert.equal(h.linearizations().count, 2);
  h.undo();
  assert.throws(() => h.relation('e1', 'e2'), (e) => e.code === 'E_UNKNOWN_EVENT');
  h.redo();
  h.redo();
  assert.equal(h.linearizations().count, 1);
  const empty = new CausalHistory();
  assert.throws(() => empty.undo(), (e) => e.code === 'E_NOOP');
  assert.throws(() => empty.redo(), (e) => e.code === 'E_NOOP');
});

test('unknown is not reported as unsatisfiable', () => {
  const h = new CausalHistory();
  h.addEvent({ id: 'e1', a: 0, b: 10, f: [0, 1, 0] });
  h.addEvent({ id: 'e2', a: 3, b: 8, f: [0, 1, 0] });
  // No information either way: concurrent, and linearizations exist.
  assert.equal(h.relation('e1', 'e2').relation, 'concurrent');
  assert.equal(h.linearizations().count, 2);
});
