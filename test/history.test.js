import test from 'node:test';
import assert from 'node:assert/strict';
import { Frac, parseRational, RationalError } from '../src/fraction.js';
import { History, correctedInterval, ERR } from '../src/history.js';
import { runCli } from '../src/cli-core.js';

const fr = (n, d = 1n) => new Frac(BigInt(n), BigInt(d));
const id = (t) => ({ c0: fr(0n), c1: fr(1n), c2: fr(0n) }); // identity correction

test('rational arithmetic is exact and normalized', () => {
  assert.equal(parseRational('3/4').toString(), '3/4');
  assert.equal(parseRational('6/8').toString(), '3/4');
  assert.equal(parseRational('-2/-4').toString(), '1/2');
  assert.equal(parseRational(0.5).toString(), '1/2');
  assert.equal(parseRational({ num: 4, den: 6 }).toString(), '2/3');
  assert.equal(fr(1n, 2n).add(fr(1n, 3n)).toString(), '5/6');
  assert.equal(fr(1n, 2n).mul(fr(2n, 3n)).toString(), '1/3');
  assert.equal(fr(1n, 2n).cmp(fr(2n, 3n)), -1);
  assert.throws(() => parseRational('1/0'), RationalError);
  assert.throws(() => parseRational('0/0'), RationalError);
});

test('correctedInterval: linear uses endpoints only', () => {
  const iv = correctedInterval(fr(0n), fr(10n), id(0));
  assert.equal(iv.lo.toString(), '0');
  assert.equal(iv.hi.toString(), '10');
  assert.equal(iv.vertex, null);
});

test('correctedInterval: interior vertex is counted exactly', () => {
  // f(t) = (t - 5)^2 = t^2 - 10t + 25 on [0, 10]: vertex t=5, value 0.
  const up = correctedInterval(fr(0n), fr(10n), { c0: fr(25n), c1: fr(-10n), c2: fr(1n) });
  assert.equal(up.lo.toString(), '0');
  assert.equal(up.hi.toString(), '25');
  assert.equal(up.vertex.t.toString(), '5');
  assert.equal(up.vertex.value.toString(), '0');
  // f(t) = -t^2 + 10t - 30 on [0, 10]: vertex t=5, value -5 (the max).
  const down = correctedInterval(fr(0n), fr(10n), { c0: fr(-30n), c1: fr(10n), c2: fr(-1n) });
  assert.equal(down.lo.toString(), '-30');
  assert.equal(down.hi.toString(), '-5');
  assert.equal(down.vertex.value.toString(), '-5');
});

test('correctedInterval: rational vertex with fractional coefficients', () => {
  // f(t) = 1/2 t^2 - t on [0, 3]: vertex t = 1, value -1/2.
  const iv = correctedInterval(fr(0n), fr(3n), { c0: fr(0n), c1: fr(-1n), c2: fr(1n, 2n) });
  assert.equal(iv.vertex.t.toString(), '1');
  assert.equal(iv.vertex.value.toString(), '-1/2');
  assert.equal(iv.lo.toString(), '-1/2');
  assert.equal(iv.hi.toString(), '3/2'); // f(3) = 9/2 - 3
});

test('correctedInterval: vertex outside interval is ignored', () => {
  // f(t) = t^2 - 10t on [0, 4]: vertex t=5 outside, monotone here.
  const iv = correctedInterval(fr(0n), fr(4n), { c0: fr(0n), c1: fr(-10n), c2: fr(1n) });
  assert.equal(iv.vertex, null);
  assert.equal(iv.lo.toString(), '-24'); // f(4) = 16 - 40
  assert.equal(iv.hi.toString(), '0'); // f(0)
});

test('acceptance 1: linear correction, overlapping events enumerate both orders', () => {
  const h = new History();
  h.importEvent({ id: 'e1', a: 0, b: 10, f: { c1: 1 } });
  h.importEvent({ id: 'e2', a: 5, b: 15, f: { c1: 1 } });
  const cmp = h.compare('e1', 'e2');
  assert.equal(cmp.relation, 'concurrent');
  assert.equal(cmp.certificate.kind, 'overlap');
  const lin = h.linearize();
  assert.equal(lin.count, 2);
  assert.deepEqual(lin.linearizations, [['e1', 'e2'], ['e2', 'e1']]);
});

test('acceptance 2: quadratic vertex yields definite order with vertex certificate', () => {
  const h = new History();
  // e1: f(t) = -t^2 + 10t - 30 on [0,10]; vertex t=5 gives max -5 -> [-30, -5].
  const r1 = h.importEvent({ id: 'e1', a: 0, b: 10, f: { c0: -30, c1: 10, c2: -1 } });
  assert.equal(r1.interval.lo, '-30');
  assert.equal(r1.interval.hi, '-5');
  assert.equal(r1.interval.vertex.value, '-5');
  // e2: identity on [0, 10] -> [0, 10]. hi(e1) = -5 < 0 = lo(e2).
  h.importEvent({ id: 'e2', a: 0, b: 10, f: { c1: 1 } });
  const cmp = h.compare('e1', 'e2');
  assert.equal(cmp.relation, 'before');
  assert.equal(cmp.certificate.kind, 'interval');
  assert.equal(cmp.certificate.first.interval.hi, '-5');
  assert.equal(cmp.certificate.first.interval.vertex.t, '5');
  assert.equal(h.compare('e2', 'e1').relation, 'after');
  const lin = h.linearize();
  assert.equal(lin.count, 1);
  assert.deepEqual(lin.linearizations, [['e1', 'e2']]);
});

test('acceptance 3: undo of a correction restores possible concurrency, redo reapplies', () => {
  const h = new History();
  h.importEvent({ id: 'e1', a: 0, b: 10, f: { c1: 1 } });
  h.importEvent({ id: 'e2', a: 5, b: 15, f: { c1: 1 } });
  assert.equal(h.compare('e1', 'e2').relation, 'concurrent');
  // Shift e1 fully into the past: f(t) = t - 100 -> [-100, -90].
  const c = h.correct('e1', { c0: -100, c1: 1, c2: 0 });
  assert.equal(c.ok, true);
  assert.equal(h.compare('e1', 'e2').relation, 'before');
  assert.equal(h.linearize().count, 1);
  // Undo restores the original overlapping interval.
  assert.deepEqual(h.undo(), { ok: true, applied: true });
  assert.equal(h.compare('e1', 'e2').relation, 'concurrent');
  assert.equal(h.linearize().count, 2);
  // Redo reapplies the correction.
  assert.deepEqual(h.redo(), { ok: true, applied: true });
  assert.equal(h.compare('e1', 'e2').relation, 'before');
  // Undo of an import removes the event.
  assert.equal(h.undo().applied, true); // undo correct
  assert.equal(h.undo().applied, true); // undo import e2
  assert.equal(h.compare('e1', 'e2').error, ERR.UNKNOWN_EVENT);
});

test('acceptance 4: contradictory constraints return E_UNSAT', () => {
  const h = new History();
  h.importEvent({ id: 'e1', a: 0, b: 10, f: { c1: 1 } });
  h.importEvent({ id: 'e2', a: 5, b: 15, f: { c1: 1 } });
  h.constrain('e1', 'e2');
  h.constrain('e2', 'e1'); // direct cycle
  const lin = h.linearize();
  assert.equal(lin.error, ERR.UNSAT);
  // Constraint contradicting the interval order is also unsatisfiable.
  const h2 = new History();
  h2.importEvent({ id: 'a', a: 0, b: 1, f: { c1: 1 } });
  h2.importEvent({ id: 'b', a: 10, b: 20, f: { c1: 1 } });
  h2.constrain('b', 'a'); // intervals force a before b
  assert.equal(h2.linearize().error, ERR.UNSAT);
  assert.equal(h2.compare('a', 'b').error, ERR.UNSAT);
});

test('unknown is never reported as unsatisfiable', () => {
  const h = new History();
  h.importEvent({ id: 'e1', a: 0, b: 10, f: { c1: 1 } });
  h.importEvent({ id: 'e2', a: 3, b: 8, f: { c1: 1 } });
  h.importEvent({ id: 'e3', a: 6, b: 20, f: { c1: 1 } });
  const lin = h.linearize();
  assert.equal(lin.ok, true);
  assert.equal(lin.count, 6); // all 3! permutations, nothing is forced
});

test('explicit happens-before chain orders otherwise-concurrent events', () => {
  const h = new History();
  h.importEvent({ id: 'e1', a: 0, b: 10, f: { c1: 1 } });
  h.importEvent({ id: 'e2', a: 0, b: 10, f: { c1: 1 } });
  h.importEvent({ id: 'e3', a: 0, b: 10, f: { c1: 1 } });
  h.constrain('e1', 'e2');
  h.constrain('e2', 'e3');
  const cmp = h.compare('e1', 'e3');
  assert.equal(cmp.relation, 'before');
  assert.deepEqual(cmp.certificate, { kind: 'chain', chain: ['e1', 'e2', 'e3'] });
  const lin = h.linearize();
  assert.equal(lin.count, 1);
  assert.deepEqual(lin.linearizations, [['e1', 'e2', 'e3']]);
});

test('E_RATIONAL: zero denominator is rejected and history is unchanged', () => {
  const h = new History();
  const bad = h.importEvent({ id: 'e1', a: 0, b: 1, f: { c0: '1/0', c1: 1, c2: 0 } });
  assert.equal(bad.error, ERR.RATIONAL);
  assert.equal(h.snapshot().events.e1, undefined);
  // A failed correction must not alter history.
  h.importEvent({ id: 'e1', a: 0, b: 10, f: { c1: 1 } });
  h.importEvent({ id: 'e2', a: 5, b: 15, f: { c1: 1 } });
  const before = h.compare('e1', 'e2');
  const badCorrect = h.correct('e1', { c0: 0, c1: { num: 1, den: 0 }, c2: 0 });
  assert.equal(badCorrect.error, ERR.RATIONAL);
  assert.deepEqual(h.compare('e1', 'e2'), before);
  assert.equal(h.undo().applied, true); // undo import e2, not a phantom correction
  assert.equal(h.undo().applied, true); // undo import e1
  assert.equal(h.undo().applied, false); // nothing left
});

test('E_RANGE: a > b is rejected', () => {
  const h = new History();
  const r = h.importEvent({ id: 'e1', a: 10, b: 0, f: { c1: 1 } });
  assert.equal(r.error, ERR.RANGE);
  assert.equal(h.snapshot().events.e1, undefined);
});

test('linearize rejects more than 7 events', () => {
  const h = new History();
  for (let i = 0; i < 8; i += 1) {
    h.importEvent({ id: `e${i}`, a: i * 10, b: i * 10 + 5, f: { c1: 1 } });
  }
  assert.equal(h.linearize().error, ERR.TOO_LARGE);
  assert.equal(h.linearize(['e0', 'e1']).ok, true);
});

test('CLI: stdin JSON batch to single-line JSON stdout', () => {
  const { line, exitCode } = runCli(JSON.stringify({
    ops: [
      { op: 'import', id: 'e1', a: 0, b: 10, f: { c0: -30, c1: 10, c2: -1 } },
      { op: 'import', id: 'e2', a: 0, b: 10, f: { c1: 1 } },
      { op: 'compare', x: 'e1', y: 'e2' },
      { op: 'linearize' },
      { op: 'correct', id: 'e1', f: { c0: '1/0' } },
      { op: 'compare', x: 'e1', y: 'e2' },
    ],
  }));
  assert.equal(exitCode, 0);
  const lines = line.trim().split('\n');
  assert.equal(lines.length, 1);
  const { results } = JSON.parse(lines[0]);
  assert.equal(results[0].interval.hi, '-5');
  assert.equal(results[2].relation, 'before');
  assert.deepEqual(results[3].linearizations, [['e1', 'e2']]);
  assert.equal(results[4].error, 'E_RATIONAL'); // invalid correction rejected
  assert.equal(results[5].relation, 'before'); // history unchanged
});

test('CLI: invalid JSON yields E_PARSE on one line', () => {
  const { line, exitCode } = runCli('not json');
  assert.equal(exitCode, 1);
  assert.deepEqual(JSON.parse(line.trim()), { error: 'E_PARSE', message: 'stdin is not valid JSON' });
});
