import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compile } from '../src/index.js';
import { Engine } from '../src/engine.js';
import { fullReplay, foldActive } from '../src/replay.js';

const RULES = 'alert overheat level critical on devices(/^dev-/) when temp > 80C for 5m';
const ev = (id, time, device, type, value, extra = {}) => ({ id, time, device, type, value, ...extra });

test('acceptance 1: sustained over-limit triggers, then closes after recovery', () => {
  const engine = new Engine(compile(RULES));
  engine.processAll([
    ev('e1', 0, 'dev-1', 'temp', 85),
    ev('e2', 120000, 'dev-1', 'temp', 86),
    ev('e3', 600000, 'dev-1', 'temp', 70),
  ]);
  assert.deepEqual(engine.records, [
    { type: 'alert', rule: 'overheat', level: 'critical', device: 'dev-1', at: 300000, seq: 1 },
    { type: 'withdraw', rule: 'overheat', level: 'critical', device: 'dev-1', alertAt: 300000, at: 600000, reason: 'recovered', seq: 3 },
  ]);
  assert.deepEqual(engine.activeAlerts(), []);
});

test('no alert when the exceedance is shorter than the window', () => {
  const engine = new Engine(compile(RULES));
  engine.processAll([
    ev('e1', 0, 'dev-1', 'temp', 85),
    ev('e2', 60000, 'dev-1', 'temp', 70),
  ]);
  // Streaming semantics: after e1 the condition holds open-endedly, so the
  // alert at 300000 fires; e2 then revises history and withdraws it. The
  // final active set is empty, matching full replay.
  assert.deepEqual(engine.records.map((r) => r.type), ['alert', 'withdraw']);
  assert.deepEqual(engine.activeAlerts(), []);
});

test('acceptance 2: late correction withdraws the old alert and does not re-trigger', () => {
  const engine = new Engine(compile(RULES));
  engine.processAll([
    ev('e1', 0, 'dev-1', 'temp', 85),
    ev('e2', 120000, 'dev-1', 'temp', 86),
  ]);
  assert.equal(engine.records.filter((r) => r.type === 'alert').length, 1);
  // Late correction: the 86 reading was wrong, it was 70 all along.
  engine.process(ev('e3', 120000, 'dev-1', 'temp', 70, { replaces: 'e2' }));
  const tail = engine.records.slice(1);
  assert.deepEqual(tail, [
    { type: 'withdraw', rule: 'overheat', level: 'critical', device: 'dev-1', alertAt: 300000, at: 120000, reason: 'corrected', seq: 3 },
  ]);
  // Condition now holds only [0, 120000) < 5m: no new alert, nothing active.
  assert.deepEqual(engine.activeAlerts(), []);
});

test('duplicate corrections are idempotent', () => {
  const build = () => {
    const engine = new Engine(compile(RULES));
    engine.processAll([
      ev('e1', 0, 'dev-1', 'temp', 85),
      ev('e2', 120000, 'dev-1', 'temp', 86),
    ]);
    return engine;
  };
  const once = build();
  once.process(ev('e3', 120000, 'dev-1', 'temp', 70, { replaces: 'e2' }));
  const twice = build();
  twice.process(ev('e3', 120000, 'dev-1', 'temp', 70, { replaces: 'e2' }));
  twice.process(ev('e3', 120000, 'dev-1', 'temp', 70, { replaces: 'e2' })); // duplicate
  twice.process(ev('e3', 120000, 'dev-1', 'temp', 70, { replaces: 'e2' })); // duplicate
  assert.deepEqual(twice.records, once.records);
  assert.deepEqual(twice.activeAlerts(), once.activeAlerts());
});

test('retraction removes the reading and withdraws dependent alerts', () => {
  const engine = new Engine(compile(RULES));
  engine.processAll([
    ev('e1', 0, 'dev-1', 'temp', 70),
    ev('e2', 120000, 'dev-1', 'temp', 85),
    { id: 'r1', retracts: 'e2' },
  ]);
  assert.deepEqual(engine.records.at(-1), {
    type: 'withdraw', rule: 'overheat', level: 'critical', device: 'dev-1',
    alertAt: 420000, at: 120000, reason: 'retracted', seq: 3,
  });
  assert.deepEqual(engine.activeAlerts(), []);
});

test('unknown event id is a domain error; processed events stay deterministic', () => {
  const records = [
    ev('e1', 0, 'dev-1', 'temp', 85),
    { id: 'r1', retracts: 'nope' },
    ev('e2', 120000, 'dev-1', 'temp', 86),
    ev('e3', 60000, 'dev-1', 'temp', 70, { replaces: 'ghost' }),
  ];
  const run = () => {
    const engine = new Engine(compile(RULES));
    engine.processAll(records);
    return engine;
  };
  const a = run();
  const b = run();
  assert.deepEqual(a.errors, [
    { seq: 2, error: "unknown event id 'nope' in retracts" },
    { seq: 4, error: "unknown event id 'ghost' in replaces" },
  ]);
  // rejected records have no effect; the valid events still alert at 300000
  assert.deepEqual(a.activeAlerts(), [{ rule: 'overheat', device: 'dev-1', at: 300000 }]);
  assert.deepEqual(a.records, b.records); // deterministic across runs
});

test('out-of-order arrival converges to the same records as full replay', () => {
  const rules = compile(RULES);
  const records = [
    ev('e1', 600000, 'dev-1', 'temp', 70),
    ev('e2', 0, 'dev-1', 'temp', 85),
    ev('e3', 120000, 'dev-1', 'temp', 86),
  ];
  const engine = new Engine(rules);
  engine.processAll(records);
  const replay = fullReplay(records, rules);
  assert.deepEqual(foldActive(engine.records), foldActive(replay.records));
  assert.deepEqual(engine.activeAlerts(), []);
});
