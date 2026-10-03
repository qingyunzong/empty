import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/engine.js';

function errorsOf(engine, cmds) {
  const out = [];
  for (const cmd of cmds) out.push(...engine.execute(cmd));
  return out.filter((r) => r.type === 'error');
}

test('zero period length is an error', () => {
  const engine = new Engine();
  const errs = errorsOf(engine, [
    { cmd: 'rule', id: 'r', device: 'd', periodStart: 0, periodLength: 0 },
  ]);
  assert.equal(errs.length, 1);
  assert.equal(errs[0].error, 'ZERO_PERIOD');
});

test('offset table gap is an error at scan time', () => {
  const engine = new Engine();
  const errs = errorsOf(engine, [
    { cmd: 'shiftTable', id: 'st', offsets: [{ start: 0, end: 100, offset: 5 }] },
    { cmd: 'rule', id: 'r', device: 'd', periodStart: 0, periodLength: 50,
      expectedOffset: 0, grace: 5, shiftTable: 'st' },
    { cmd: 'cutoff', time: 300 },
    { cmd: 'scan' },
  ]);
  assert.equal(errs.length, 1);
  assert.equal(errs[0].error, 'OFFSET_GAP');
  assert.equal(errs[0].time, 100);
});

test('overlapping offset entries are rejected', () => {
  const engine = new Engine();
  const errs = errorsOf(engine, [
    { cmd: 'shiftTable', id: 'st', offsets: [
      { start: 0, end: 100, offset: 0 },
      { start: 50, end: 150, offset: 1 },
    ] },
  ]);
  assert.equal(errs.length, 1);
  assert.equal(errs[0].error, 'OFFSET_TABLE_OVERLAP');
});

test('event time inversion is an error for append and override', () => {
  const engine = new Engine();
  const errs = errorsOf(engine, [
    { cmd: 'heartbeat', id: 'h1', device: 'd', time: 50 },
    { cmd: 'heartbeat', id: 'h2', device: 'd', time: 40 },
  ]);
  assert.equal(errs.length, 1);
  assert.equal(errs[0].error, 'TIME_INVERSION');

  const errs2 = errorsOf(engine, [
    { cmd: 'cutoff', time: 100 },
    { cmd: 'override', id: 'h1', time: 30 },
  ]);
  assert.equal(errs2.length, 1);
  assert.equal(errs2[0].error, 'TIME_INVERSION');
});

test('unknown and duplicate events are errors', () => {
  const engine = new Engine();
  const errs = errorsOf(engine, [
    { cmd: 'heartbeat', id: 'h1', device: 'd', time: 10 },
    { cmd: 'heartbeat', id: 'h1', device: 'd', time: 20 },
    { cmd: 'cutoff', time: 100 },
    { cmd: 'retract', id: 'nope' },
    { cmd: 'override', id: 'nope', time: 30 },
  ]);
  assert.deepEqual(errs.map((e) => e.error),
    ['DUPLICATE_EVENT', 'UNKNOWN_EVENT', 'UNKNOWN_EVENT']);
});

test('scan and correction before cutoff are errors', () => {
  const engine = new Engine();
  const errs = errorsOf(engine, [
    { cmd: 'heartbeat', id: 'h1', device: 'd', time: 10 },
    { cmd: 'scan' },
    { cmd: 'retract', id: 'h1' },
  ]);
  assert.deepEqual(errs.map((e) => e.error), ['NO_CUTOFF', 'NO_CUTOFF']);
});

test('missing end-of-stream is not an error; tail alarm is OPEN', () => {
  const engine = new Engine();
  const out = [];
  for (const cmd of [
    { cmd: 'rule', id: 'r', device: 'd', periodStart: 0, periodLength: 10,
      expectedOffset: 0, grace: 2 },
    { cmd: 'heartbeat', id: 'h1', device: 'd', time: 0 },
    { cmd: 'cutoff', time: 50 },
    { cmd: 'scan' },
  ]) out.push(...engine.execute(cmd));
  assert.equal(out.filter((r) => r.type === 'error').length, 0);
  const rec = out.find((r) => r.type === 'alarms');
  assert.deepEqual(rec.alarms, [
    { start: 10, end: 50, status: 'OPEN', missedPeriods: [1, 2, 3, 4] },
  ]);
});
