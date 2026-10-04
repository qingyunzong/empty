// Acceptance 2: undo_to restores the checkpoint stack; continuing afterwards
// solves exactly like replaying the effective log from scratch.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine, replay } from '../src/engine.js';
import { InputError } from '../src/model.js';

test('undo to intermediate checkpoint then continue == replay from scratch', () => {
  const e = new Engine();
  const log = [
    { type: 'config', coordBins: 4, magBins: 2, capacity: 3 },
    { type: 'add_obs', id: 'o1', star: 's1', night: 0, ts: 1, coord: 0, mag: 0, conf: 0.9 },
    { type: 'add_obs', id: 'o2', star: 's2', night: 0, ts: 1, coord: 1, mag: 0, conf: 0.8 },
    { type: 'checkpoint', name: 'cp1' },
    { type: 'add_obs', id: 'o3', star: 's3', night: 0, ts: 1, coord: 2, mag: 0, conf: 0.7 },
    { type: 'correct_obs', id: 'o1', coord: 3 },
    { type: 'checkpoint', name: 'cp2' },
    { type: 'add_obs', id: 'o4', star: 's1', night: 1, ts: 2, coord: 1, mag: 1, conf: 0.6 },
    { type: 'undo_to', name: 'cp2' },
    { type: 'add_obs', id: 'o5', star: 's3', night: 1, ts: 3, coord: 2, mag: 1, conf: 0.9 },
    { type: 'retract_obs', id: 'o2' },
    { type: 'solve', budget: { propagation: 10000, backtrack: 1000 } },
  ];
  const outs = log.map((ev) => e.applyEvent(ev));
  const solveOut = outs.at(-1);
  assert.equal(solveOut.status, 'SAT');

  // The effective log (including checkpoint/undo_to events) replays identically.
  const replayed = replay(e.events);
  assert.deepEqual(solveOut, replayed.outputs.at(-1));
  assert.deepEqual(e.state, replayed.engine.state);
});

test('level-skipping undo rolls back only to the nearest consistent point', () => {
  const e = new Engine();
  e.applyEvent({ type: 'add_obs', id: 'o1', star: 's1', night: 0, ts: 1, coord: 0, mag: 0, conf: 1 });
  e.applyEvent({ type: 'checkpoint', name: 'cp1' });
  e.applyEvent({ type: 'add_obs', id: 'o2', star: 's2', night: 0, ts: 1, coord: 1, mag: 0, conf: 1 });
  e.applyEvent({ type: 'checkpoint', name: 'cp2' });
  e.applyEvent({ type: 'add_obs', id: 'o3', star: 's3', night: 0, ts: 1, coord: 2, mag: 0, conf: 1 });

  // Requesting the deeper cp1 must not skip over cp2.
  const skipped = e.applyEvent({ type: 'undo_to', name: 'cp1' });
  assert.equal(skipped.warning, 'UNDO_LEVEL_SKIP');
  assert.equal(skipped.requested, 'cp1');
  assert.equal(skipped.restored, 'cp2');
  assert.ok(e.state.obs.o1.active && e.state.obs.o2.active);
  assert.equal(e.state.obs.o3, undefined, 'rolled back to cp2 only');

  // cp2 was popped; cp1 is now the top and can be restored exactly.
  assert.throws(() => e.applyEvent({ type: 'undo_to', name: 'cp2' }), InputError);
  const exact = e.applyEvent({ type: 'undo_to', name: 'cp1' });
  assert.equal(exact.warning, undefined);
  assert.equal(exact.restored, 'cp1');
  assert.ok(e.state.obs.o1.active);
  assert.equal(e.state.obs.o2, undefined);
});

test('undo_to unknown checkpoint or empty stack is invalid input', () => {
  const e = new Engine();
  assert.throws(() => e.applyEvent({ type: 'undo_to', name: 'nope' }), /checkpoint stack is empty/);
  e.applyEvent({ type: 'checkpoint', name: 'cp' });
  assert.throws(() => e.applyEvent({ type: 'undo_to', name: 'nope' }), /unknown checkpoint/);
});

test('nested checkpoints: failed inner attempt restores nearest consistent point', () => {
  const e = new Engine();
  e.applyEvent({ type: 'add_obs', id: 'o1', star: 's1', night: 0, ts: 1, coord: 0, mag: 0, conf: 1 });
  e.applyEvent({ type: 'checkpoint', name: 'outer' });
  e.applyEvent({ type: 'add_obs', id: 'o2', star: 's2', night: 0, ts: 1, coord: 1, mag: 0, conf: 1 });
  e.applyEvent({ type: 'checkpoint', name: 'inner' });
  e.applyEvent({ type: 'add_obs', id: 'o3', star: 's3', night: 0, ts: 1, coord: 2, mag: 0, conf: 1 });
  // Inner "fails": we ask for outer, but only the nearest point (inner) is restored.
  const out = e.applyEvent({ type: 'undo_to', name: 'outer' });
  assert.equal(out.warning, 'UNDO_LEVEL_SKIP');
  assert.equal(out.restored, 'inner');
  const s = e.applyEvent({ type: 'solve' });
  assert.equal(s.status, 'SAT');
  assert.deepEqual(s.cells['0'], { s1: 0, s2: 4 });
});
