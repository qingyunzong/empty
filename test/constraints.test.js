// Named constraints and their UNSAT cores.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/engine.js';

function engineWith(events, config = { coordBins: 4, magBins: 2, capacity: 4 }) {
  const e = new Engine(config);
  for (const ev of events) e.applyEvent(ev);
  return e;
}

test('unique_key: duplicate (star, night, cell) observations', () => {
  const e = engineWith([
    { type: 'add_obs', id: 'o1', star: 's1', night: 0, ts: 1, coord: 0, mag: 0, conf: 0.9 },
    { type: 'add_obs', id: 'o2', star: 's1', night: 0, ts: 2, coord: 0, mag: 0, conf: 0.8 },
  ]);
  const r = e.applyEvent({ type: 'solve' });
  assert.equal(r.status, 'UNSAT');
  assert.deepEqual(r.unsatCore.constraints, ['unique_key']);
  assert.deepEqual(r.unsatCore.obs, ['o1', 'o2']);
  assert.deepEqual(r.unsatCore.events, [0, 1]);
});

test('time_order: timestamps must be non-decreasing in event order per star', () => {
  const e = engineWith([
    { type: 'add_obs', id: 'o1', star: 's1', night: 0, ts: 5, coord: 0, mag: 0, conf: 0.9 },
    { type: 'add_obs', id: 'o2', star: 's1', night: 0, ts: 3, coord: 1, mag: 0, conf: 0.8 },
  ]);
  const r = e.applyEvent({ type: 'solve' });
  assert.equal(r.status, 'UNSAT');
  assert.deepEqual(r.unsatCore.constraints, ['time_order']);
  assert.deepEqual(r.unsatCore.obs, ['o1', 'o2']);
});

test('time_order can be violated by a correction and fixed by a retraction', () => {
  const e = engineWith([
    { type: 'add_obs', id: 'o1', star: 's1', night: 0, ts: 1, coord: 0, mag: 0, conf: 0.9 },
    { type: 'add_obs', id: 'o2', star: 's1', night: 0, ts: 2, coord: 1, mag: 0, conf: 0.8 },
    { type: 'correct_obs', id: 'o2', ts: 0 },
  ]);
  const bad = e.applyEvent({ type: 'solve' });
  assert.equal(bad.status, 'UNSAT');
  assert.deepEqual(bad.unsatCore.constraints, ['time_order']);
  assert.ok(bad.unsatCore.events.includes(2), 'core names the correcting event');
  e.applyEvent({ type: 'retract_obs', id: 'o2' });
  const good = e.applyEvent({ type: 'solve' });
  assert.equal(good.status, 'SAT');
});

test('exclusive_cell: two stars, one cell', () => {
  const e = engineWith(
    [
      { type: 'add_obs', id: 'o1', star: 's1', night: 0, ts: 1, coord: 0, mag: 0, conf: 1 },
      { type: 'add_obs', id: 'o2', star: 's2', night: 0, ts: 1, coord: 0, mag: 0, conf: 1 },
    ],
    { coordBins: 1, magBins: 1, capacity: 4 },
  );
  const r = e.applyEvent({ type: 'solve' });
  assert.equal(r.status, 'UNSAT');
  assert.deepEqual(r.unsatCore.constraints, ['exclusive_cell']);
  assert.deepEqual(r.unsatCore.obs, ['o1', 'o2']);
});

test('night_capacity: minimal core has capacity+1 observations', () => {
  const e = engineWith(
    [
      { type: 'add_obs', id: 'o1', star: 's1', night: 0, ts: 1, coord: 0, mag: 0, conf: 1 },
      { type: 'add_obs', id: 'o2', star: 's2', night: 0, ts: 1, coord: 1, mag: 0, conf: 1 },
      { type: 'add_obs', id: 'o3', star: 's3', night: 0, ts: 1, coord: 2, mag: 0, conf: 1 },
    ],
    { coordBins: 4, magBins: 1, capacity: 2 },
  );
  const r = e.applyEvent({ type: 'solve' });
  assert.equal(r.status, 'UNSAT');
  assert.deepEqual(r.unsatCore.constraints, ['night_capacity']);
  assert.equal(r.unsatCore.obs.length, 3, 'capacity 2 -> core of 3');
});

test('superseded observations are reported in the SAT model', () => {
  const e = engineWith([
    { type: 'add_obs', id: 'o1', star: 's1', night: 0, ts: 1, coord: 0, mag: 0, conf: 0.9 },
    { type: 'add_obs', id: 'o2', star: 's1', night: 0, ts: 2, coord: 1, mag: 0, conf: 0.8 },
  ]);
  const r = e.applyEvent({ type: 'solve' });
  assert.equal(r.status, 'SAT');
  assert.equal(r.superseded.length, 1);
  assert.equal(r.superseded[0].reason, 'cell_not_selected');
  assert.equal(r.model['0'].s1.obs, 'o1', 'higher confidence observation wins');
});
