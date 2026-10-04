import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildIndex, effectivePermission } from '../src/config.js';
import { parseEvents } from '../src/events.js';
import { applyEvent, compareDecisionEvents, createState, foldEvents } from '../src/state.js';
import { GateError, EXIT } from '../src/errors.js';
import { threeShiftConfig, ev, resetEventClock } from './helpers.js';

test('permission inherits order -> work center -> product line', () => {
  const config = threeShiftConfig();
  config.productLines['PL-1'].workCenters['WC-1'].orders['WO-1'].permission = 'deny';
  config.productLines['PL-1'].workCenters['WC-1'].permission = 'deny';
  const idx = buildIndex(config);
  assert.equal(effectivePermission(idx, 'WO-1'), 'deny'); // order wins
  assert.equal(effectivePermission(idx, 'WO-2'), 'deny'); // falls to work center
  idx.orders.get('WO-1').permission = 'allow';
  assert.equal(effectivePermission(idx, 'WO-1'), 'allow'); // order overrides center
  idx.centers.get('WC-1').permission = 'inherit';
  assert.equal(effectivePermission(idx, 'WO-2'), 'allow'); // falls to product line
});

test('decision comparator: ts, priority, freeze-wins tie, seq', () => {
  const rel = { seq: 1, ts: 100, type: 'release', priority: 0 };
  const frz = { seq: 2, ts: 100, type: 'freeze', priority: 0 };
  assert.ok(compareDecisionEvents(frz, rel) > 0, 'freeze wins same-instant tie');
  assert.ok(compareDecisionEvents(rel, frz) < 0);
  const hiPri = { seq: 3, ts: 100, type: 'release', priority: 5 };
  assert.ok(compareDecisionEvents(hiPri, frz) > 0, 'higher priority wins');
  const later = { seq: 4, ts: 200, type: 'release', priority: 0 };
  assert.ok(compareDecisionEvents(later, hiPri) > 0, 'later timestamp wins');
  const rel2 = { seq: 9, ts: 100, type: 'release', priority: 0 };
  assert.ok(compareDecisionEvents(rel2, rel) > 0, 'same type: later seq wins');
});

test('time backwards throws exit 5', () => {
  resetEventClock();
  const idx = buildIndex(threeShiftConfig());
  const events = parseEvents(
    `${JSON.stringify({ ts: '2026-10-04T21:00:00Z', type: 'release', order: 'WO-1' })}\n` +
      `${JSON.stringify({ ts: '2026-10-04T20:00:00Z', type: 'freeze', order: 'WO-1' })}\n`,
  );
  assert.throws(() => foldEvents(events, idx), (err) => {
    assert.ok(err instanceof GateError);
    assert.equal(err.code, EXIT.TIME_BACKWARDS);
    return true;
  });
});

test('reschedule into the past throws exit 5', () => {
  const idx = buildIndex(threeShiftConfig());
  const events = parseEvents(
    `${JSON.stringify({ ts: '2026-10-04T21:00:00Z', type: 'reschedule', order: 'WO-1', to: '2026-10-04T20:00:00Z' })}\n`,
  );
  assert.throws(() => foldEvents(events, idx), (err) => {
    assert.equal(err.code, EXIT.TIME_BACKWARDS);
    return true;
  });
});

test('negative capability throws exit 6', () => {
  const config = threeShiftConfig();
  config.productLines['PL-1'].workCenters['WC-1'].capabilities.assembly = -1;
  assert.throws(() => buildIndex(config), (err) => {
    assert.equal(err.code, EXIT.NEGATIVE_CAPABILITY);
    return true;
  });
});

test('unknown material throws exit 7', () => {
  const config = threeShiftConfig();
  config.productLines['PL-1'].workCenters['WC-1'].orders['WO-1'].materials = { 'M-999': 1 };
  assert.throws(() => buildIndex(config), (err) => {
    assert.equal(err.code, EXIT.UNKNOWN_MATERIAL);
    return true;
  });
});

test('revoke by non-supervisor is an invalid-revoke breach, freeze stands', () => {
  resetEventClock();
  const idx = buildIndex(threeShiftConfig());
  const events = [
    ev('release', { order: 'WO-1' }),
    ev('freeze', { order: 'WO-1' }),
    ev('revoke', { target: 2, actor: 'planner' }),
  ];
  const state = foldEvents(events, idx);
  assert.equal(state.orders['WO-1'].decision, 'frozen');
  assert.equal(state.breaches.filter((b) => b.reason === 'invalid-revoke').length, 1);
});

test('material shortage records breach and holds no lock', () => {
  resetEventClock();
  const config = threeShiftConfig();
  config.materials['M-2'].stock = 1; // WO-2 needs 2
  const idx = buildIndex(config);
  const state = foldEvents([ev('release', { order: 'WO-2' })], idx);
  assert.equal(state.orders['WO-2'].decision, 'released');
  assert.deepEqual(state.orders['WO-2'].locks, {});
  assert.equal(state.breaches.filter((b) => b.reason === 'material-shortage').length, 1);
  assert.equal(state.stock['M-2'], 1);
});

test('events on unknown orders become breaches, not crashes', () => {
  resetEventClock();
  const idx = buildIndex(threeShiftConfig());
  const state = foldEvents([ev('release', { order: 'WO-XXX' })], idx);
  assert.equal(state.breaches[0].reason, 'unknown-order');
});

test('applyEvent is deterministic: same input, same state', () => {
  resetEventClock();
  const idx = buildIndex(threeShiftConfig());
  const events = [
    ev('release', { order: 'WO-1' }),
    ev('freeze', { order: 'WO-1' }),
    ev('revoke', { target: 2, actor: 'supervisor' }),
  ];
  const a = foldEvents(events, idx);
  const b = foldEvents(events, idx);
  assert.deepEqual(a, b);
});
