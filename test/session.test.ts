import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DebugSession,
  hashState,
  type Instruction,
} from '../src/index.js';

// Reads values until 0, accumulating a sum kept in the heap; prints the sum.
//   0: IN R0          4: ADDI R2, 1
//   1: JZ R0, 6       5: JMP 0
//   2: ADD R1, R0     6: OUT R1
//   3: STORE [10], R1 7: HALT
const SUM_PROGRAM: Instruction[] = [
  { op: 'IN', reg: 0 },
  { op: 'JZ', reg: 0, target: 6 },
  { op: 'ADD', reg: 1, src: 0 },
  { op: 'STORE', addr: 10, reg: 1 },
  { op: 'ADDI', reg: 2, imm: 1 },
  { op: 'JMP', target: 0 },
  { op: 'OUT', reg: 1 },
  { op: 'HALT' },
];

const INPUTS = [5, 7, 0];
const TOTAL_EVENTS = 16;

function recordedSession(): DebugSession {
  const session = new DebugSession(SUM_PROGRAM);
  const result = session.continue(INPUTS.slice());
  assert.equal(result.stop, 'halted');
  return session;
}

test('records every executed instruction and every external input', () => {
  const session = recordedSession();
  assert.equal(session.events.length, TOTAL_EVENTS);
  session.events.forEach((event, i) => assert.equal(event.seq, i));
  assert.deepEqual([...session.inputs], INPUTS);

  const inEvents = session.events.filter((e) => e.inputUsed !== null);
  assert.deepEqual(inEvents.map((e) => e.seq), [0, 6, 12]);
  assert.deepEqual(inEvents.map((e) => e.inputUsed), INPUTS);

  const finalState = session.state;
  assert.equal(finalState.registers[1], 12);
  assert.equal(finalState.heap[10], 12);
  assert.deepEqual(finalState.output, [12]);
  assert.equal(session.currentVersion.finalHash, hashState(finalState));
});

test('jumpTo restores registers and heap at any event seq', () => {
  const session = recordedSession();
  const restored = session.jumpTo(8); // just after ADD made the sum 12
  assert.equal(restored.registers[1], 12);
  assert.equal(restored.heap[10], 5); // STORE of 12 happens at seq 9
  assert.equal(restored.pc, 3);
  assert.equal(restored.inputsConsumed, 2);
  assert.equal(session.nextSeq, 9);

  const initial = session.jumpTo(-1);
  assert.deepEqual(initial.registers, new Array(8).fill(0));
  assert.equal(initial.pc, 0);

  assert.throws(() => session.jumpTo(TOTAL_EVENTS), RangeError);
});

test('continue after jump replays with recorded inputs and verifies each step', () => {
  const session = recordedSession();
  const finalHash = session.currentVersion.finalHash;

  session.jumpTo(5); // right before the second IN
  const result = session.continue(); // no new inputs: recorded ones are used
  assert.equal(result.stop, 'halted');
  assert.equal(result.verified, 10);
  assert.equal(result.recorded, 0);
  assert.equal(session.events.length, TOTAL_EVENTS); // nothing appended
  assert.equal(hashState(session.state), finalHash);
  assert.equal(session.versionCount, 1);
});

test('step-by-step replay from the start verifies every event', () => {
  const session = recordedSession();
  session.jumpTo(-1);
  let verified = 0;
  for (;;) {
    const result = session.step();
    if (result.kind === 'halted') break;
    assert.equal(result.kind, 'verified');
    verified += 1;
  }
  assert.equal(verified, TOTAL_EVENTS);
  assert.equal(session.events.length, TOTAL_EVENTS);
  assert.ok(session.verify().ok);
});

test('a diverging new input forks a new version and keeps the original intact', () => {
  const session = recordedSession();
  const originalFinalHash = session.currentVersion.finalHash;

  session.jumpTo(5); // next event (seq 6) is IN with recorded value 7
  session.supplyInput(9);
  const first = session.step();
  assert.equal(first.kind, 'forked');
  assert.equal(session.versionCount, 2);
  assert.equal(session.currentVersionId, 1);

  const fork = session.currentVersion;
  assert.equal(fork.parentId, 0);
  assert.equal(fork.forkSeq, 5);
  assert.equal(fork.events.length, 7); // shared prefix 0..5 plus the new IN
  assert.deepEqual(fork.inputs, [5, 9]);

  // The fork has no more recorded inputs: it must ask for them.
  const stalled = session.continue();
  assert.equal(stalled.stop, 'need-input');
  session.supplyInput(0);
  const done = session.continue();
  assert.equal(done.stop, 'halted');
  assert.equal(session.state.registers[1], 14);
  assert.deepEqual(session.state.output, [14]);
  assert.equal(session.state.heap[10], 14);
  assert.ok(session.verify(1).ok);

  // Original version is untouched.
  const original = session.listVersions().find((v) => v.id === 0)!;
  assert.equal(original.eventCount, TOTAL_EVENTS);
  assert.deepEqual(original.inputs, INPUTS);
  assert.equal(original.finalHash, originalFinalHash);
  assert.ok(session.verify(0).ok);
});

test('re-supplying the recorded input does not fork', () => {
  const session = recordedSession();
  session.jumpTo(5);
  session.supplyInput(7); // same as the recording
  const result = session.continue();
  assert.equal(result.stop, 'halted');
  assert.equal(session.versionCount, 1);
  assert.equal(session.events.length, TOTAL_EVENTS);
});

test('breakpoints pause execution but are not execution events', () => {
  const session = new DebugSession(SUM_PROGRAM);
  session.setBreakpoint(2); // ADD, reached once per loop iteration

  const first = session.continue(INPUTS.slice());
  assert.equal(first.stop, 'breakpoint');
  assert.equal(first.breakpointPc, 2);
  assert.equal(session.events.length, 2); // only IN and JZ executed
  assert.deepEqual(session.breakpointHits, [{ pc: 2, nextSeq: 2 }]);

  const second = session.continue();
  assert.equal(second.stop, 'breakpoint');
  assert.equal(session.events.length, 8);
  assert.deepEqual(session.breakpointHits[1], { pc: 2, nextSeq: 8 });

  const third = session.continue();
  assert.equal(third.stop, 'halted');
  // Exactly one event per executed instruction; breakpoint hits add none.
  assert.equal(session.events.length, TOTAL_EVENTS);
  session.events.forEach((event, i) => assert.equal(event.seq, i));
  assert.equal(session.breakpointHits.length, 2);
  assert.ok(session.verify().ok);
});

test('verify replays a version and checks every full-state snapshot', () => {
  const session = recordedSession();
  const report = session.verify();
  assert.ok(report.ok);
  assert.equal(report.eventsChecked, TOTAL_EVENTS);
});

test('verify detects a tampered snapshot hash', () => {
  const session = recordedSession();
  (session.events[4] as { hash: string }).hash = 'deadbeef';
  const report = session.verify();
  assert.equal(report.ok, false);
  assert.equal(report.mismatch?.seq, 4);
});

test('verify detects a tampered snapshot state', () => {
  const session = recordedSession();
  session.events[7].state.registers[1] = 999;
  const report = session.verify();
  assert.equal(report.ok, false);
  assert.equal(report.mismatch?.seq, 7);
});

test('snapshots handed out are deep copies', () => {
  const session = recordedSession();
  const snap = session.snapshotAt(8);
  snap.registers[1] = -1;
  snap.heap[10] = -1;
  const again = session.snapshotAt(8);
  assert.equal(again.registers[1], 12);
  assert.equal(again.heap[10], 5);
});

test('forkAt creates an explicit branch that records independently', () => {
  const session = recordedSession();
  const forkId = session.forkAt(11); // after the second JMP, before third IN
  assert.equal(forkId, 1);
  assert.equal(session.currentVersion.events.length, 12);

  const stalled = session.continue();
  assert.equal(stalled.stop, 'need-input');
  session.continue([0]);
  assert.ok(session.halted);
  assert.equal(session.state.registers[1], 12);
  assert.ok(session.verify(1).ok);
  assert.ok(session.verify(0).ok);
});
