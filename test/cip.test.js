import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine, inCleanWindow } from '../src/engine.js';

const MIN = 60 * 1000;
const t = (min) => min * MIN;
const cip = (op, startMin, endMin, ok = true, eventTs = null) => ({
  type: 'cip', eventTs: eventTs ?? t(startMin), line: 'L1', start: t(startMin), end: t(endMin), ok, op,
});
const fill = (op, batch, min) => ({ type: 'fill', eventTs: t(min), batch, vol: 500, weight: 500, op });

test('fill must sit after the last ok CIP and before the next CIP', () => {
  const e = new Engine();
  e.process(cip('cip-1', 0, 10, true));
  e.process(fill('f1', 'B1', 20)); // inside clean window
  assert.equal(e.state.get('B1').state, 'HOLD');

  e.process(fill('f2', 'B2', 20));
  e.process(cip('cip-2', 15, 25, true, t(30))); // CIP starts at 15 -> fills at 20 now dirty
  assert.equal(e.state.get('B1').state, 'REJECT');
  assert.equal(e.state.get('B1').reason, 'CIP_WINDOW');
  assert.equal(e.state.get('B2').reason, 'CIP_WINDOW');
});

test('fill before any ok CIP is rejected', () => {
  const e = new Engine();
  e.process(fill('f1', 'B1', 5));
  assert.equal(e.state.get('B1').reason, 'CIP_WINDOW');
  e.process(cip('cip-1', 0, 4, true, t(6))); // ended before the fill
  assert.equal(e.state.get('B1').state, 'HOLD');
});

test('failed CIP does not open a clean window', () => {
  const e = new Engine();
  e.process(cip('cip-1', 0, 10, true));
  e.process(cip('cip-2', 20, 30, false)); // failed wash
  e.process(fill('f1', 'B1', 40)); // after failed CIP, line still dirty
  assert.equal(e.state.get('B1').reason, 'CIP_WINDOW');
});

test('CIP retract re-assigns fills across the cleaning boundary', () => {
  const e = new Engine();
  e.process(cip('cip-1', 0, 10, true));
  e.process(fill('f1', 'B1', 20)); // window of cip-1
  e.process(cip('cip-2', 30, 40, true, t(30)));
  e.process(fill('f2', 'B2', 50)); // window of cip-2
  assert.equal(e.state.get('B1').state, 'HOLD');
  assert.equal(e.state.get('B2').state, 'HOLD');

  // retract cip-2: f2 (t=50) re-belongs to cip-1's window, still clean
  e.process({ type: 'retract', eventTs: t(60), kind: 'cip', id: 'cip-2' });
  assert.equal(e.state.get('B2').state, 'HOLD');
  assert.equal(e.comp.length, 0); // no visible state change -> no compensation
});

test('CIP retract rolls a boundary REJECT back to HOLD (re-assignment)', () => {
  const e = new Engine();
  e.process(cip('cip-1', 0, 10, true));
  e.process(cip('cip-2', 20, 30, false, t(20))); // failed wash blocks the window
  e.process(fill('f1', 'B1', 40));
  assert.equal(e.state.get('B1').state, 'REJECT');
  assert.equal(e.state.get('B1').reason, 'CIP_WINDOW');

  e.process({ type: 'retract', eventTs: t(50), kind: 'cip', id: 'cip-2' });
  assert.equal(e.state.get('B1').state, 'HOLD'); // re-assigned into cip-1's window
  const c = e.comp.find((x) => x.batch === 'B1');
  assert.ok(c && c.from === 'REJECT' && c.to === 'HOLD' && c.retractedId === 'cip-2');
});

test('inCleanWindow unit checks', () => {
  const cips = [
    { start: 0, end: 10, ok: true },
    { start: 100, end: 110, ok: true },
  ];
  assert.equal(inCleanWindow(10, cips), true);
  assert.equal(inCleanWindow(99, cips), true);
  assert.equal(inCleanWindow(100, cips), false); // next CIP already started
  assert.equal(inCleanWindow(111, cips), true);
  assert.equal(inCleanWindow(-1, cips), false); // before any ok CIP
  assert.equal(inCleanWindow(50, [{ start: 0, end: 10, ok: false }]), false);
});
