import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine, AppError } from '../src/engine.js';
import { Frac } from '../src/rational.js';

const make = (limit = '100') => {
  const e = new Engine();
  e.apply({ op: 'init', limit });
  return e;
};
const code = (fn) => { try { fn(); } catch (e) { return e.code; } throw new Error('expected throw'); };

test('acceptance 1: freeze-capture-void restores limit exactly', () => {
  const e = make('5');
  e.apply({ op: 'freeze', tx: 't', amt: '1/3' });
  const { result } = e.apply({ op: 'capture', tx: 't', amt: '1/6' }); // settles 17/100
  assert.equal(result.capId, 'c0');
  e.apply({ op: 'void', tx: 't' });
  const s = e.snapshot();
  assert.equal(s.frozen, '0');                 // hold fully released, exact
  assert.deepEqual(s.holds, {});
  assert.equal(s.captured, '17/100');          // 1/6 rounded HALF_EVEN to cents
  assert.equal(s.available, '483/100');        // 5 - 17/100, exact rational
  // exact-cents cycle: freeze + full capture + reverse returns to the limit
  e.apply({ op: 'freeze', tx: 'u', amt: '1/4' });
  e.apply({ op: 'capture', tx: 'u', amt: '1/4' });
  e.apply({ op: 'reverse', captureId: 'c1' });
  const s2 = e.snapshot();
  assert.equal(s2.frozen, '0');
  assert.equal(s2.captured, '17/100');
  assert.equal(s2.available, '483/100');
});

test('capture rounding coupling: unrecoverable trial -> whole op E_STATE', () => {
  const e = make('9/1000'); // 0.009
  e.apply({ op: 'freeze', tx: 't', amt: '1/160' }); // 0.00625 <= 0.009 ok
  const err = code(() => e.apply({ op: 'capture', tx: 't', amt: '1/160' }));
  assert.equal(err, 'E_STATE'); // settles to 0.01 > limit 0.009
  const s = e.snapshot();       // nothing applied: hold intact
  assert.equal(s.holds.t, '1/160');
  assert.equal(s.captured, '0');
  assert.equal(s.available, '11/4000'); // 9/1000 - 1/160
});

test('capture rounding to zero cents is E_STATE', () => {
  const e = make('1');
  e.apply({ op: 'freeze', tx: 't', amt: '1/300' });
  assert.equal(code(() => e.apply({ op: 'capture', tx: 't', amt: '1/300' })), 'E_STATE');
});

test('reverse: parallel candidates pick smallest amount then lexicographic id', () => {
  const e = make('100');
  e.apply({ op: 'freeze', tx: 'a', amt: '10' });
  e.apply({ op: 'capture', tx: 'a', amt: '5' });  // c0 settled 5
  e.apply({ op: 'freeze', tx: 'b', amt: '10' });
  e.apply({ op: 'capture', tx: 'b', amt: '3' });  // c1 settled 3
  e.apply({ op: 'freeze', tx: 'c', amt: '10' });
  e.apply({ op: 'capture', tx: 'c', amt: '3' });  // c2 settled 3
  e.apply({ op: 'reverse', captureId: 'c' });     // prefix matches c0,c1,c2
  let caps = Object.keys(e.snapshot().captures);
  assert.deepEqual(caps.sort(), ['c0', 'c2']);    // c1: min amount, min id
  e.apply({ op: 'reverse', captureId: 'c' });
  caps = Object.keys(e.snapshot().captures);
  assert.deepEqual(caps.sort(), ['c0', 'c1'].filter((x) => x === 'c0')); // c2 gone
  e.apply({ op: 'reverse', captureId: 'c0' });    // exact id
  assert.deepEqual(e.snapshot().captures, {});
  assert.equal(e.snapshot().captured, '0');
});

test('acceptance 2: merge conflict returns verifiable counterexample', () => {
  const e = make('10');
  e.apply({ op: 'freeze', tx: 't1', amt: '6' });        // main: frozen 6
  e.apply({ op: 'branch', fromEvent: 1, name: 'b' });   // branch after event 0
  e.apply({ op: 'void', tx: 't1' });                    // b: release 6
  e.apply({ op: 'freeze', tx: 't2', amt: '9' });        // b: frozen 9 (ok on branch)
  e.apply({ op: 'use', branch: 'main' });
  e.apply({ op: 'freeze', tx: 't3', amt: '4' });        // main: frozen 10
  let err;
  try { e.apply({ op: 'merge', branch: 'b' }); } catch (x) { err = x; }
  assert.equal(err.code, 'E_STATE');
  const ce = err.details.counterexample;
  assert.equal(ce.index, 1);
  assert.deepEqual(ce.event, { op: 'freeze', tx: 't2', amt: '9' });
  // verify the counterexample independently: frozen before + requested > limit
  const frozenBefore = Frac.parse(ce.stateBefore.frozen);
  const requested = Frac.parse(ce.event.amt);
  const limit = Frac.parse(ce.stateBefore.limit);
  assert.equal(frozenBefore.toString(), '4'); // after replaying void t1 on main tip
  assert.ok(frozenBefore.add(requested).cmp(limit) > 0, 'counterexample must violate the invariant');
  // failed merge changes nothing
  assert.equal(e.snapshot().frozen, '10');
});

test('merge success appends branch events to parent', () => {
  const e = make('100');
  e.apply({ op: 'freeze', tx: 'a', amt: '10' });
  e.apply({ op: 'branch', fromEvent: 1, name: 'b' });
  e.apply({ op: 'freeze', tx: 'c', amt: '20' });
  const r = e.apply({ op: 'merge', branch: 'b' });
  assert.equal(r.result.into, 'main');
  const s = e.snapshot();
  assert.equal(s.branch, 'main');
  assert.equal(s.frozen, '30');
  assert.deepEqual(Object.keys(s.holds).sort(), ['a', 'c']);
});

test('layered undo: child rollback never undoes merged ancestors', () => {
  const e = make('100');
  e.apply({ op: 'freeze', tx: 'a', amt: '10' });          // trunk
  e.apply({ op: 'branch', fromEvent: 1, name: 'b1' });
  e.apply({ op: 'freeze', tx: 'b', amt: '20' });          // in b1
  e.apply({ op: 'merge', branch: 'b1' });                 // trunk: a,b
  e.apply({ op: 'branch', fromEvent: 2, name: 'b2' });
  e.apply({ op: 'freeze', tx: 'c', amt: '30' });          // in b2
  e.apply({ op: 'rollback', branch: 'b2' });              // drop only b2 events
  const s = e.snapshot();
  assert.equal(s.frozen, '30');                           // a+b intact, c gone
  assert.deepEqual(Object.keys(s.holds).sort(), ['a', 'b']);
  // nested: merge grandchild into child, then rollback child; trunk untouched
  e.apply({ op: 'branch', fromEvent: 2, name: 'x' });
  e.apply({ op: 'branch', fromEvent: 2, name: 'y' });     // y child of x
  e.apply({ op: 'freeze', tx: 'd', amt: '5' });           // in y
  e.apply({ op: 'merge', branch: 'y' });                  // y -> x
  e.apply({ op: 'rollback', branch: 'x' });               // drops d, keeps trunk
  const s2 = e.snapshot();
  assert.equal(s2.frozen, '30');
  assert.deepEqual(Object.keys(s2.holds).sort(), ['a', 'b']);
});

test('rollback blocked by active child; merged branch cannot rollback', () => {
  const e = make('100');
  e.apply({ op: 'branch', fromEvent: 0, name: 'p' });
  e.apply({ op: 'branch', fromEvent: 0, name: 'q' });
  assert.equal(code(() => e.apply({ op: 'rollback', branch: 'p' })), 'E_STATE');
  e.apply({ op: 'merge', branch: 'q' });
  assert.equal(code(() => e.apply({ op: 'rollback', branch: 'q' })), 'E_STATE');
});

test('E_REF and E_PARSE paths', () => {
  const e = make('10');
  assert.equal(code(() => e.apply({ op: 'void', tx: 'nope' })), 'E_REF');
  assert.equal(code(() => e.apply({ op: 'capture', tx: 'nope', amt: '1' })), 'E_REF');
  assert.equal(code(() => e.apply({ op: 'reverse', captureId: 'nope' })), 'E_REF');
  assert.equal(code(() => e.apply({ op: 'branch', fromEvent: 5 })), 'E_REF');
  assert.equal(code(() => e.apply({ op: 'merge', branch: 'nope' })), 'E_REF');
  assert.equal(code(() => e.apply({ op: 'use', branch: 'nope' })), 'E_REF');
  assert.equal(code(() => e.apply({ op: 'freeze', tx: 't', amt: 'abc' })), 'E_PARSE');
  assert.equal(code(() => e.apply({ op: 'freeze', amt: '1' })), 'E_PARSE');
  assert.equal(code(() => e.apply({ op: 'wat' })), 'E_PARSE');
  assert.equal(code(() => e.apply('freeze')), 'E_PARSE');
  assert.equal(code(() => e.apply({ op: 'branch', fromEvent: 1.5 })), 'E_PARSE');
});

test('E_STATE paths: duplicate hold, over-limit, over-hold, non-positive', () => {
  const e = make('10');
  e.apply({ op: 'freeze', tx: 't', amt: '7' });
  assert.equal(code(() => e.apply({ op: 'freeze', tx: 't', amt: '1' })), 'E_STATE');
  assert.equal(code(() => e.apply({ op: 'freeze', tx: 'u', amt: '4' })), 'E_STATE'); // 7+4>10
  assert.equal(code(() => e.apply({ op: 'capture', tx: 't', amt: '8' })), 'E_STATE');
  assert.equal(code(() => e.apply({ op: 'freeze', tx: 'v', amt: '0' })), 'E_STATE');
  assert.equal(code(() => e.apply({ op: 'freeze', tx: 'v', amt: '-1/2' })), 'E_STATE');
});

test('replay: folding recorded ops reproduces live state', () => {
  const e = make('50');
  const records = [{ op: 'init', limit: '50' }];
  const ops = [
    { op: 'freeze', tx: 'a', amt: '10/3' },
    { op: 'capture', tx: 'a', amt: '1/3' },
    { op: 'branch', fromEvent: 1 },
    { op: 'freeze', tx: 'b', amt: '5' },
    { op: 'merge', branch: 'b0' },
    { op: 'void', tx: 'b' },
    { op: 'reverse', captureId: 'c0' },
  ];
  for (const op of ops) records.push(e.apply(op).record);
  const replayed = new Engine();
  for (const rec of records) replayed.apply(rec);
  assert.deepEqual(replayed.snapshot(), e.snapshot());
});
