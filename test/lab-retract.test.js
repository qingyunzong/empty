import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/engine.js';

const CIP = { type: 'cip', eventTs: 0, line: 'L1', start: -2000, end: -1000, ok: true, op: 'cip-0' };
const FILL = { type: 'fill', eventTs: 1000, batch: 'B1', vol: 500, weight: 500, op: 'fill-1' };

test('lab retract rolls RELEASE safely back to HOLD with compensation', () => {
  const e = new Engine();
  e.process(CIP);
  e.process(FILL);
  assert.equal(e.state.get('B1').state, 'HOLD'); // missing lab is pinned to HOLD

  e.process({ type: 'lab', eventTs: 2000, batch: 'B1', pass: true, op: 'lab-1' });
  assert.equal(e.state.get('B1').state, 'RELEASE');

  e.process({ type: 'retract', eventTs: 3000, kind: 'lab', id: 'lab-1' });
  assert.equal(e.state.get('B1').state, 'HOLD');
  assert.equal(e.state.get('B1').reason, 'AWAITING_LAB');

  // compensation record emitted
  assert.equal(e.comp.length, 1);
  assert.deepEqual(
    { batch: e.comp[0].batch, retractedId: e.comp[0].retractedId, from: e.comp[0].from, to: e.comp[0].to },
    { batch: 'B1', retractedId: 'lab-1', from: 'RELEASE', to: 'HOLD' },
  );

  // audit trail: EMPTY -> HOLD -> RELEASE -> HOLD, append-only with monotonic seq
  const path = e.transitions.map((t) => `${t.seq}:${t.from}->${t.to}`);
  assert.deepEqual(path, ['1:EMPTY->HOLD', '2:HOLD->RELEASE', '3:RELEASE->HOLD']);
  assert.ok(e.transitions.every((t, i) => i === 0 || t.seq > e.transitions[i - 1].seq));
});

test('retract of unknown op is a no-op', () => {
  const e = new Engine();
  e.process(CIP);
  e.process(FILL);
  e.process({ type: 'retract', eventTs: 2000, kind: 'lab', id: 'nope' });
  assert.equal(e.state.get('B1').state, 'HOLD');
  assert.equal(e.transitions.length, 1);
  assert.equal(e.comp.length, 0);
});

test('retract with mismatched kind is a no-op', () => {
  const e = new Engine();
  e.process(CIP);
  e.process(FILL);
  e.process({ type: 'retract', eventTs: 2000, kind: 'cip', id: 'fill-1' });
  assert.equal(e.state.get('B1').state, 'HOLD');
  assert.equal(e.comp.length, 0);
});

test('lab-fail REJECT rolls back to HOLD when that lab is retracted', () => {
  const e = new Engine();
  e.process(CIP);
  e.process(FILL);
  e.process({ type: 'lab', eventTs: 2000, batch: 'B1', pass: false, op: 'lab-bad' });
  assert.equal(e.state.get('B1').state, 'REJECT');
  assert.equal(e.state.get('B1').reason, 'LAB_FAIL');
  e.process({ type: 'retract', eventTs: 3000, kind: 'lab', id: 'lab-bad' });
  assert.equal(e.state.get('B1').state, 'HOLD');
  assert.equal(e.comp.length, 1);
});

test('late lab still flips HOLD to RELEASE and is logged', () => {
  const e = new Engine();
  e.process(CIP);
  e.process(FILL); // window end = 1000
  // a much later event pushes the watermark past the fill window
  e.process({ type: 'cip', eventTs: 10 * 60 * 1000, line: 'L1', start: 11 * 60 * 1000, end: 12 * 60 * 1000, ok: true, op: 'cip-1' });
  e.process({ type: 'lab', eventTs: 2000, batch: 'B1', pass: true, op: 'lab-late' });
  assert.equal(e.state.get('B1').state, 'RELEASE');
  assert.ok(e.late.some((l) => l.reason === 'LATE_LAB_WINDOW_CLOSED' && l.op === 'lab-late'));
});
