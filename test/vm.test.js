import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runEngine } from '../src/engine.js';

const RULES = `
field temp: C;
field current: A;
group sensors = /^sensor-[0-9]+$/;
rule overtemp on sensors {
  alert critical when temp > 80C for 5m;
}
`;

const ev = (id, min, device, type, value, extra = {}) =>
  JSON.stringify({ id, time: Date.UTC(2026, 0, 1, 0, min, 0), device, type, value, ...extra });
const jsonl = (...lines) => lines.join('\n') + '\n';

// Acceptance 1: sustained over-limit triggers, and closes after recovery.
test('sustained over-limit triggers at exactly 5m and closes on recovery', () => {
  const r = runEngine(RULES, jsonl(
    ev('e1', 0, 'sensor-1', 'temp', 85),
    ev('e2', 4, 'sensor-1', 'temp', 86),   // still high, no alert yet
    ev('e3', 6, 'sensor-1', 'temp', 87),   // crosses t0+5m -> alert at 00:05
    ev('e4', 8, 'sensor-1', 'temp', 70),   // recovery -> close at 00:08
  ));
  assert.equal(r.ok, true);
  assert.deepEqual(r.records.map((x) => [x.kind, x.time, x.reason ?? null]), [
    ['alert', '2026-01-01T00:05:00.000Z', null],
    ['withdraw', '2026-01-01T00:08:00.000Z', 'recovered'],
  ]);
  assert.equal(r.records[0].alert, r.records[1].alert);
  assert.equal(r.records[0].level, 'critical');
});

test('brief spikes below the duration never trigger', () => {
  const r = runEngine(RULES, jsonl(
    ev('e1', 0, 'sensor-1', 'temp', 85),
    ev('e2', 3, 'sensor-1', 'temp', 70),   // breaks continuity
    ev('e3', 4, 'sensor-1', 'temp', 90),
    ev('e4', 8, 'sensor-1', 'temp', 60),   // 90C held only 4m
  ));
  assert.equal(r.ok, true);
  assert.deepEqual(r.records, []);
});

test('alert fires at hold expiry even past the last event (flush)', () => {
  const r = runEngine(RULES, jsonl(ev('e1', 0, 'sensor-1', 'temp', 85)));
  assert.equal(r.records.length, 1);
  assert.equal(r.records[0].kind, 'alert');
  assert.equal(r.records[0].time, '2026-01-01T00:05:00.000Z');
});

// Acceptance 2: a late correction withdraws the stale alert and does not
// re-trigger when the corrected history still satisfies the rule.
test('late correction withdraws the old alert without duplicate trigger', () => {
  const r = runEngine(RULES, jsonl(
    ev('e1', 0, 'sensor-1', 'temp', 85),
    ev('e2', 6, 'sensor-1', 'temp', 86),          // alert opens at 00:05
    ev('e3', 7, 'sensor-1', 'temp', 70, { replaces: 'e1' }), // correction: e1 was 70C
  ));
  assert.equal(r.ok, true);
  const [alert, withdraw] = r.records;
  assert.equal(alert.kind, 'alert');
  assert.equal(withdraw.kind, 'withdraw');
  assert.equal(withdraw.alert, alert.alert);
  assert.equal(withdraw.reason, 'corrected');
  assert.equal(r.records.filter((x) => x.kind === 'alert').length, 1);
  assert.deepEqual(r.errors, []);
});

test('correction that only moves the trigger keeps one continuous alert', () => {
  const r = runEngine(RULES, jsonl(
    ev('e1', 0, 'sensor-1', 'temp', 85),
    ev('e2', 6, 'sensor-1', 'temp', 86),          // alert at 00:05
    ev('e3', 1, 'sensor-1', 'temp', 84, { replaces: 'e1' }), // still >80C from 00:01
  ));
  assert.equal(r.ok, true);
  // Start moved 00:05 -> 00:06? No: 84C at 00:01 -> alert at 00:06.
  const alerts = r.records.filter((x) => x.kind === 'alert');
  const withdraws = r.records.filter((x) => x.kind === 'withdraw');
  assert.equal(alerts.length, 2); // old interval withdrawn, corrected interval alerted
  assert.equal(withdraws.length, 1);
  assert.equal(withdraws[0].reason, 'corrected');
  assert.equal(alerts[1].time, '2026-01-01T00:06:00.000Z');
});

test('duplicate correction is idempotent', () => {
  const line = ev('e3', 7, 'sensor-1', 'temp', 70, { replaces: 'e1' });
  const r = runEngine(RULES, jsonl(
    ev('e1', 0, 'sensor-1', 'temp', 85),
    ev('e2', 6, 'sensor-1', 'temp', 86),
    line,
    line, // exact duplicate: no-op
  ));
  assert.equal(r.ok, true);
  assert.equal(r.records.filter((x) => x.kind === 'alert').length, 1);
  assert.equal(r.records.filter((x) => x.kind === 'withdraw').length, 1);
});

test('retraction removes the alert it caused', () => {
  const r = runEngine(RULES, jsonl(
    ev('e1', 0, 'sensor-1', 'temp', 85),
    ev('e2', 6, 'sensor-1', 'temp', 86),
    JSON.stringify({ id: 'e3', retracts: 'e1' }),
    JSON.stringify({ id: 'e4', retracts: 'e2' }),
  ));
  assert.equal(r.ok, true);
  assert.equal(r.records[0].kind, 'alert');
  const withdraws = r.records.filter((x) => x.kind === 'withdraw');
  assert.equal(withdraws.length, 1);
  assert.ok(withdraws.every((w) => w.reason === 'corrected'));
  // Nothing remains: every emitted alert was withdrawn.
  assert.deepEqual(
    r.records.filter((x) => x.kind === 'alert').map((x) => x.alert).sort(),
    withdraws.map((x) => x.alert).sort(),
  );
});

test('retraction can shift the alert start; final state matches full replay', () => {
  // After e1 is retracted, e2's 86C reading persists from 00:06, so the
  // hold expires at 00:11: the stale alert is withdrawn and, at flush, the
  // shifted alert opens -- exactly what a full replay computes.
  const r = runEngine(RULES, jsonl(
    ev('e1', 0, 'sensor-1', 'temp', 85),
    ev('e2', 6, 'sensor-1', 'temp', 86),
    JSON.stringify({ id: 'e3', retracts: 'e1' }),
  ));
  assert.equal(r.ok, true);
  const alerts = r.records.filter((x) => x.kind === 'alert');
  const withdraws = r.records.filter((x) => x.kind === 'withdraw');
  assert.equal(alerts.length, 2);
  assert.equal(withdraws.length, 1);
  assert.equal(withdraws[0].reason, 'corrected');
  assert.equal(alerts[1].time, '2026-01-01T00:11:00.000Z');
});

test('out-of-order event is integrated consistently', () => {
  const r = runEngine(RULES, jsonl(
    ev('e2', 6, 'sensor-1', 'temp', 86),
    ev('e1', 0, 'sensor-1', 'temp', 85), // late arrival, backfills history
  ));
  assert.equal(r.ok, true);
  assert.equal(r.records[0].kind, 'alert');
  assert.equal(r.records[0].time, '2026-01-01T00:05:00.000Z');
});

test('unknown event id in replaces is a domain error; processed events stay', () => {
  const r = runEngine(RULES, jsonl(
    ev('e1', 0, 'sensor-1', 'temp', 85),
    ev('e2', 6, 'sensor-1', 'temp', 86),           // alert opens
    ev('e3', 7, 'sensor-1', 'temp', 70, { replaces: 'nope' }),
    ev('e4', 8, 'sensor-1', 'temp', 70),           // never processed
  ));
  assert.equal(r.ok, false);
  assert.equal(r.errors.length, 1);
  assert.equal(r.errors[0].event, 3); // JSONL line number
  assert.match(r.errors[0].message, /unknown event id "nope"/);
  // Events before the error are still deterministic: the alert stands.
  assert.deepEqual(r.records.map((x) => x.kind), ['alert']);
  assert.equal(r.stats.events, 2);
});

test('unknown event id in retracts is a domain error', () => {
  const r = runEngine(RULES, jsonl(
    ev('e1', 0, 'sensor-1', 'temp', 85),
    JSON.stringify({ id: 'e2', retracts: 'ghost' }),
  ));
  assert.equal(r.ok, false);
  assert.match(r.errors[0].message, /unknown event id "ghost"/);
  assert.equal(r.errors[0].event, 2);
});

test('events for non-matching devices produce no records', () => {
  const r = runEngine(RULES, jsonl(
    ev('e1', 0, 'sensor-1', 'temp', 20), // keeps the device group non-empty
    ev('e2', 0, 'pump-1', 'temp', 200),
  ));
  assert.equal(r.ok, true);
  assert.deepEqual(r.records, []);
});
