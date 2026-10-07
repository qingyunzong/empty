import test from 'node:test';
import assert from 'node:assert/strict';
import { Ledger } from '../src/ledger.js';
import { Frac, roundHalfEven } from '../src/frac.js';
import { LedgerError } from '../src/errors.js';

test('ROUND_HALF_EVEN rounds half to even at cent scale', () => {
  assert.equal(roundHalfEven(Frac.parse('33.335')).toString(), '1667/50'); // 33.34 (3 is odd -> up)
  assert.equal(roundHalfEven(Frac.parse('33.325')).toString(), '833/25'); // 33.32 (2 is even -> down)
  assert.equal(roundHalfEven(Frac.parse('2.675')).toString(), '67/25'); // 2.68
  assert.equal(roundHalfEven(Frac.parse('1/3')).toString(), '33/100'); // 0.333... -> 0.33
  assert.equal(roundHalfEven(Frac.parse('10.005')).toString(), '10/1'); // 1000.5 -> 1000 (even)
  assert.equal(roundHalfEven(Frac.parse('-2.345')).toString(), '-117/50'); // -2.34
});

test('Frac parses and normalizes rationals', () => {
  assert.equal(Frac.parse('2/4').toString(), '1/2');
  assert.equal(Frac.parse('3/-6').toString(), '-1/2');
  assert.equal(Frac.parse('0.1').toString(), '1/10');
  assert.equal(Frac.parse('7').toString(), '7/1');
  assert.throws(() => Frac.parse('1/0'), (e) => e.code === 'E_PARSE');
  assert.throws(() => Frac.parse('abc'), (e) => e.code === 'E_PARSE');
});

// ---------- acceptance 1 ----------
test('acceptance 1: freeze-capture-void restores credit exactly (exact rationals)', () => {
  const l = new Ledger('1000/1');
  l.apply({ type: 'freeze', tx: 't1', amt: '100/1' });
  assert.equal(l.snapshot().available, '900/1');

  l.apply({ type: 'capture', tx: 't1', amt: '33335/1000' }); // 33.335 -> RHE 33.34
  let s = l.snapshot();
  assert.equal(s.debt, '1667/50'); // 33.34 exactly
  assert.equal(s.frozen.t1, '3333/50'); // 100 - 33.34

  l.apply({ type: 'void', tx: 't1' });
  s = l.snapshot();
  assert.equal(s.frozenTotal, '0/1');
  assert.equal(s.available, '48333/50'); // 1000 - 33.34, exact

  l.apply({ type: 'reverse', captureId: 'cap#2' });
  s = l.snapshot();
  assert.equal(s.debt, '0/1');
  assert.equal(s.available, '1000/1'); // fully restored, no drift
});

test('capture rounding coupling: unrecoverable release fails atomically with E_STATE', () => {
  const l = new Ledger('100/1');
  l.apply({ type: 'freeze', tx: 't1', amt: '10/1' });
  // 10.006 rounds to 10.01 > 10 frozen -> whole op rejected, freeze untouched
  assert.throws(
    () => l.apply({ type: 'capture', tx: 't1', amt: '10.006' }),
    (e) => e.code === 'E_STATE',
  );
  assert.equal(l.snapshot().frozen.t1, '10/1');
  assert.equal(l.snapshot().debt, '0/1');
  // 10.005 rounds half-even to exactly 10.00 -> allowed, consumes the freeze
  l.apply({ type: 'capture', tx: 't1', amt: '10.005' });
  assert.equal(l.snapshot().debt, '10/1');
  // tiny amount rounding to zero is E_STATE as well
  const l2 = new Ledger('100/1');
  l2.apply({ type: 'freeze', tx: 'x', amt: '1/1' });
  assert.throws(
    () => l2.apply({ type: 'capture', tx: 'x', amt: '1/1000' }),
    (e) => e.code === 'E_STATE',
  );
});

// ---------- acceptance 2 ----------
test('acceptance 2: branch merge conflict returns a verifiable counterexample', () => {
  const l = new Ledger('100/1');
  l.apply({ type: 'freeze', tx: 't1', amt: '80/1' }); // seq 1 on main
  l.apply({ type: 'branch', name: 'b1', fromEvent: 1 });
  l.apply({ type: 'capture', tx: 't1', amt: '70/1', id: 'c-b1' }); // on b1
  l.apply({ type: 'checkout', name: 'main' });
  l.apply({ type: 'capture', tx: 't1', amt: '70/1', id: 'c-main' }); // main: frozen 10, debt 70

  let err;
  try {
    l.apply({ type: 'merge', branch: 'b1' });
  } catch (e) {
    err = e;
  }
  assert.ok(err instanceof LedgerError);
  assert.equal(err.code, 'E_STATE');
  const cx = err.details.counterexample;
  assert.equal(cx.branch, 'b1');
  assert.equal(cx.failingOp.id, 'c-b1');
  assert.equal(cx.index, 0);

  // Verify the counterexample independently: replay the failing op against the
  // captured stateBefore and confirm the invariant violation.
  const remainder = Frac.parse(cx.stateBefore.frozen.t1); // '10/1'
  const rounded = roundHalfEven(Frac.parse(cx.failingOp.amt)); // 70/1
  assert.ok(rounded.cmp(remainder) > 0, 'counterexample must actually violate the invariant');
  assert.equal(cx.stateBefore.debt, '70/1');

  // Merge is atomic: main state unchanged, nothing partially merged.
  const s = l.snapshot();
  assert.equal(s.debt, '70/1');
  assert.equal(s.captures.some((c) => c.id === 'c-b1'), false);
});

test('layered undo tree: child rollback never undoes merged ancestors', () => {
  const l = new Ledger('1000/1');
  l.apply({ type: 'freeze', tx: 't1', amt: '100/1' }); // seq 1, main
  l.apply({ type: 'branch', name: 'b1', fromEvent: 1 });
  l.apply({ type: 'capture', tx: 't1', amt: '30/1', id: 'cb' }); // on b1
  l.apply({ type: 'checkout', name: 'main' });
  l.apply({ type: 'capture', tx: 't1', amt: '20/1', id: 'cm' }); // on main
  const r = l.apply({ type: 'merge', branch: 'b1' });
  assert.equal(r.merged, 1);
  assert.equal(l.snapshot().debt, '50/1');

  // Roll the child branch all the way back to its base.
  l.apply({ type: 'checkout', name: 'b1' });
  l.apply({ type: 'undo' });
  assert.throws(
    () => l.apply({ type: 'undo' }),
    (e) => e.code === 'E_STATE',
  );
  assert.equal(l.snapshot().debt, '0/1'); // child's own view is rolled back

  // The merged ancestor events on main are untouched.
  l.apply({ type: 'checkout', name: 'main' });
  assert.equal(l.snapshot().debt, '50/1');
});

test('reverse tie-break: smallest amount, then lexicographic event id', () => {
  const l = new Ledger('1000/1');
  for (const tx of ['a', 'b', 'c']) l.apply({ type: 'freeze', tx, amt: '10/1' });
  l.apply({ type: 'capture', tx: 'a', amt: '5/1', id: 'dup' }); // eventId '4'
  l.apply({ type: 'capture', tx: 'b', amt: '3/1', id: 'dup' }); // eventId '5'
  l.apply({ type: 'capture', tx: 'c', amt: '3/1', id: 'dup' }); // eventId '6'
  l.apply({ type: 'reverse', captureId: 'dup' });
  const caps = l.snapshot().captures;
  assert.equal(caps.find((c) => c.eventId === '5').reversed, true); // 3 < 5 by amount
  assert.equal(caps.find((c) => c.eventId === '6').reversed, false);
  assert.equal(l.snapshot().debt, '8/1'); // 5 + 3 remain
});

test('reverse tie-break uses lexicographic (not numeric) event id order', () => {
  const l = new Ledger('1000/1');
  for (let i = 0; i < 8; i++) l.apply({ type: 'freeze', tx: `f${i}`, amt: '1/1' }); // seq 1..8
  l.apply({ type: 'freeze', tx: 'a', amt: '10/1' }); // seq 9
  l.apply({ type: 'freeze', tx: 'b', amt: '10/1' }); // seq 10
  l.apply({ type: 'capture', tx: 'a', amt: '3/1', id: 'dup' }); // eventId '11'
  l.apply({ type: 'capture', tx: 'b', amt: '3/1', id: 'dup' }); // eventId '12'
  // lexicographic: '11' < '12'; craft a '9' vs '10' case below instead
  l.apply({ type: 'reverse', captureId: 'dup' });
  assert.equal(l.snapshot().captures.find((c) => c.eventId === '11').reversed, true);

  const l2 = new Ledger('1000/1');
  for (let i = 0; i < 7; i++) l2.apply({ type: 'freeze', tx: `f${i}`, amt: '1/1' }); // seq 1..7
  l2.apply({ type: 'freeze', tx: 'a', amt: '10/1' }); // seq 8
  l2.apply({ type: 'capture', tx: 'a', amt: '3/1', id: 'dup' }); // eventId '9'
  l2.apply({ type: 'freeze', tx: 'b', amt: '10/1' }); // seq 10
  l2.apply({ type: 'capture', tx: 'b', amt: '3/1', id: 'dup' }); // eventId '11'
  l2.apply({ type: 'reverse', captureId: 'dup' });
  // lexicographic order: '11' < '9', so the seq-11 capture is reversed first
  assert.equal(l2.snapshot().captures.find((c) => c.eventId === '11').reversed, true);
  assert.equal(l2.snapshot().captures.find((c) => c.eventId === '9').reversed, false);
});

test('E_REF on dangling references and duplicates', () => {
  const l = new Ledger('100/1');
  assert.throws(() => l.apply({ type: 'capture', tx: 'nope', amt: '1/1' }), (e) => e.code === 'E_REF');
  assert.throws(() => l.apply({ type: 'void', tx: 'nope' }), (e) => e.code === 'E_REF');
  assert.throws(() => l.apply({ type: 'reverse', captureId: 'nope' }), (e) => e.code === 'E_REF');
  assert.throws(() => l.apply({ type: 'merge', branch: 'nope' }), (e) => e.code === 'E_REF');
  assert.throws(() => l.apply({ type: 'branch', name: 'b', fromEvent: 99 }), (e) => e.code === 'E_REF');
  l.apply({ type: 'freeze', tx: 't', amt: '1/1' });
  assert.throws(() => l.apply({ type: 'freeze', tx: 't', amt: '1/1' }), (e) => e.code === 'E_REF');
  l.apply({ type: 'branch', name: 'b', fromEvent: 1 });
  assert.throws(() => l.apply({ type: 'branch', name: 'b', fromEvent: 1 }), (e) => e.code === 'E_REF');
});

test('E_STATE on over-limit freeze; E_PARSE on malformed events', () => {
  const l = new Ledger('100/1');
  assert.throws(() => l.apply({ type: 'freeze', tx: 't', amt: '101/1' }), (e) => e.code === 'E_STATE');
  assert.throws(() => l.apply({ type: 'freeze', tx: 't', amt: 'abc' }), (e) => e.code === 'E_PARSE');
  assert.throws(() => l.apply({ type: 'freeze', amt: '1/1' }), (e) => e.code === 'E_PARSE');
  assert.throws(() => l.apply({ type: 'wat' }), (e) => e.code === 'E_PARSE');
  assert.throws(() => l.apply(null), (e) => e.code === 'E_PARSE');
  assert.throws(() => l.apply({ type: 'freeze', tx: 't', amt: '0/1' }), (e) => e.code === 'E_STATE');
});
