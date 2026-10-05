import { test } from 'node:test';
import { equal, ok } from 'node:assert/strict';
import { parseProgram } from '../src/parser';
import { dependent, enabledThreads, initialState, isDeadlock, step } from '../src/state';
import { Instr } from '../src/model';

test('read/write/lock/unlock/assert step semantics', () => {
  const p = parseProgram(`
var x = 0
mutex m
thread A
  lock m
  write x 7
  read r x
  assert r == 7
  unlock m
end
`);
  let s = initialState(p);
  equal(enabledThreads(p, s).length, 1);

  let r = step(p, s, 0); // lock m
  equal(r.next.mutexOwner.m, 0);
  r = step(p, r.next, 0); // write x 7
  equal(r.next.vars.x, 7);
  r = step(p, r.next, 0); // read r x
  equal(r.next.regs[0].r, 7);
  r = step(p, r.next, 0); // assert r == 7
  equal(r.violation, null);
  r = step(p, r.next, 0); // unlock m
  equal(r.next.mutexOwner.m, -1);
  equal(r.violation, null);
});

test('failing assert reports a violation with values', () => {
  const p = parseProgram('var x = 5\nthread A\n  read r x\n  assert r == 6\nend\n');
  const s1 = step(p, initialState(p), 0).next;
  const r = step(p, s1, 0);
  ok(r.violation !== null);
  equal(r.violation!.kind, 'assert');
  ok(/5 == 6 is false/.test(r.violation!.message));
});

test('lock blocks other threads; unlock by non-owner is a model error', () => {
  const p = parseProgram(`
mutex m
thread A
  lock m
  unlock m
end
thread B
  lock m
  unlock m
end
`);
  const s1 = step(p, initialState(p), 0).next; // A locks m
  equal(enabledThreads(p, s1).length, 1);      // B is blocked
  const bad = step(p, s1, 0);                  // A unlocks... first step A again? pc=1 -> unlock
  equal(bad.violation, null);
  // unlock without ownership:
  const p2 = parseProgram('mutex m\nthread A\n  unlock m\nend\n');
  const r2 = step(p2, initialState(p2), 0);
  ok(r2.violation !== null);
  equal(r2.violation!.kind, 'model');
});

test('deadlock detection on lock-order inversion state', () => {
  const p = parseProgram(`
mutex a
mutex b
thread A
  lock a
  lock b
end
thread B
  lock b
  lock a
end
`);
  let s = initialState(p);
  s = step(p, s, 0).next; // A locks a
  s = step(p, s, 1).next; // B locks b
  equal(enabledThreads(p, s).length, 0);
  ok(isDeadlock(p, s));
});

test('independence relation', () => {
  const rdX: Instr = { op: 'read', reg: 'r', variable: 'x' };
  const rdX2: Instr = { op: 'read', reg: 's', variable: 'x' };
  const wrX: Instr = { op: 'write', variable: 'x', value: { kind: 'const', value: 1 } };
  const wrY: Instr = { op: 'write', variable: 'y', value: { kind: 'const', value: 1 } };
  const lockM: Instr = { op: 'lock', mutex: 'm' };
  const unlockM: Instr = { op: 'unlock', mutex: 'm' };
  const lockN: Instr = { op: 'lock', mutex: 'n' };
  const assertion: Instr = { op: 'assert', left: { kind: 'reg', name: 'r' }, cmp: '==', right: { kind: 'const', value: 0 } };

  equal(dependent(rdX, rdX2), false);   // read/read commutes
  equal(dependent(rdX, wrX), true);     // read/write conflicts
  equal(dependent(wrX, wrX), true);     // write/write conflicts
  equal(dependent(wrX, wrY), false);    // different variables
  equal(dependent(lockM, unlockM), true);
  equal(dependent(lockM, lockN), false);
  equal(dependent(assertion, wrX), false); // assert is thread-local
  equal(dependent(assertion, lockM), false);
});
