import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/engine.js';

const CIP = { type: 'cip', eventTs: 0, line: 'L1', start: -2000, end: -1000, ok: true, op: 'cip-0' };

test('weight/volume contradiction stays REJECT and lab cannot flip it', () => {
  const e = new Engine();
  e.process(CIP);
  // 500 mL but only 100 g -> density 0.2 g/mL, far outside [0.95, 1.10]
  e.process({ type: 'fill', eventTs: 1000, batch: 'B1', vol: 500, weight: 100, op: 'fill-1' });
  assert.equal(e.state.get('B1').state, 'REJECT');
  assert.equal(e.state.get('B1').reason, 'DENSITY_MISMATCH');

  e.process({ type: 'lab', eventTs: 2000, batch: 'B1', pass: true, op: 'lab-1' });
  assert.equal(e.state.get('B1').state, 'REJECT'); // lab pass must NOT flip
  assert.equal(e.state.get('B1').reason, 'DENSITY_MISMATCH');
  assert.ok(!e.transitions.some((t) => t.from === 'REJECT' && t.to === 'RELEASE'));
});

test('vol <= 0 is reported as VOL_INVALID', () => {
  const e = new Engine();
  e.process(CIP);
  e.process({ type: 'fill', eventTs: 1000, batch: 'B1', vol: 0, weight: 500, op: 'fill-1' });
  assert.equal(e.state.get('B1').state, 'REJECT');
  assert.equal(e.state.get('B1').reason, 'VOL_INVALID');
  e.process({ type: 'fill', eventTs: 1000, batch: 'B2', vol: -5, weight: 500, op: 'fill-2' });
  assert.equal(e.state.get('B2').reason, 'VOL_INVALID');
});

test('density REJECT recovers only by retracting the offending fill, never via lab', () => {
  const e = new Engine();
  e.process(CIP);
  e.process({ type: 'fill', eventTs: 1000, batch: 'B1', vol: 500, weight: 500, op: 'fill-ok' });
  e.process({ type: 'fill', eventTs: 1100, batch: 'B1', vol: 500, weight: 900, op: 'fill-bad' }); // 1.8 g/mL
  assert.equal(e.state.get('B1').reason, 'DENSITY_MISMATCH');
  e.process({ type: 'lab', eventTs: 2000, batch: 'B1', pass: true, op: 'lab-1' });
  assert.equal(e.state.get('B1').state, 'REJECT');
  e.process({ type: 'retract', eventTs: 3000, kind: 'fill', id: 'fill-bad' });
  assert.equal(e.state.get('B1').state, 'RELEASE'); // good fill + already-arrived lab pass
  assert.equal(e.comp.length, 1);
});

test('density exactly on the bounds is accepted', () => {
  const e = new Engine();
  e.process(CIP);
  e.process({ type: 'fill', eventTs: 1000, batch: 'B1', vol: 1000, weight: 950, op: 'f1' }); // 0.95
  e.process({ type: 'fill', eventTs: 1000, batch: 'B2', vol: 1000, weight: 1100, op: 'f2' }); // 1.10
  assert.equal(e.state.get('B1').state, 'HOLD');
  assert.equal(e.state.get('B2').state, 'HOLD');
});
