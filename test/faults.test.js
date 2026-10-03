import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runCli, tmpdir, inputFile, readJsonl } from './helpers/cli.js';
import { FAULT_POINTS } from '../src/store.js';

const EVENTS = [
  { id: 'e1', ts: 1000, device: 'plc-1', lot: 'L1', kind: 'quality.hold', payload: { reason: 'suspect' } },
  { id: 'e2', ts: 2000, device: 'plc-1', lot: 'L1', kind: 'device.alarm', payload: { code: 'E42' } },
  { id: 'e3', ts: 3000, device: 'plc-1', lot: 'L1', kind: 'quality.check', payload: { result: 'pass' } },
  { id: 'e4', ts: 4000, device: 'plc-1', lot: 'L1', kind: 'device.clear', payload: {} },
  { id: 'e5', ts: 5000, device: 'plc-1', lot: 'L1', kind: 'quality.release', payload: { by: 'op-7' } },
];

function cleanRun() {
  const dir = tmpdir();
  const r = runCli(['ingest', '--dir', dir, '--file', inputFile(EVENTS)]);
  assert.equal(r.status, 0, r.stderr);
  return dir;
}

function snapshot(dir) {
  return {
    events: readJsonl(path.join(dir, 'events.log')),
    lots: JSON.parse(fs.readFileSync(path.join(dir, 'lots.json'), 'utf8')),
    index: JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8')),
    audit: readJsonl(path.join(dir, 'audit.log')),
  };
}

test('exactly-once recovery across all six fault points', () => {
  const expected = snapshot(cleanRun());
  for (const point of FAULT_POINTS) {
    const dir = tmpdir();
    const crashed = runCli(['ingest', '--dir', dir, '--file', inputFile(EVENTS)], {
      env: { EVENT_TRACE_FAULT: point, EVENT_TRACE_FAULT_TX: 'e3' },
    });
    assert.equal(crashed.status, 99, `${point}: expected crash exit 99, got ${crashed.status}: ${crashed.stderr}`);
    assert.match(crashed.stderr, /FAULT_INJECTED/);

    const resumed = runCli(['resume', '--dir', dir]);
    assert.equal(resumed.status, 0, `${point}: resume failed: ${resumed.stderr}`);

    const actual = snapshot(dir);
    const ids = actual.events.map((e) => e.id);
    assert.deepEqual(new Set(ids).size, ids.length, `${point}: duplicate ids in events.log`);
    assert.deepEqual(actual.events, expected.events, `${point}: events.log differs`);
    assert.deepEqual(actual.lots, expected.lots, `${point}: lots.json differs`);
    assert.deepEqual(actual.index, expected.index, `${point}: index.json differs`);
    assert.deepEqual(actual.audit, expected.audit, `${point}: audit.log differs`);

    // Re-ingesting the same input after recovery must be a no-op.
    const again = runCli(['ingest', '--dir', dir, '--file', inputFile(EVENTS)]);
    assert.equal(again.status, 0, `${point}: re-ingest failed`);
    const report = JSON.parse(again.stdout);
    assert.equal(report.applied.length, 0, `${point}: re-ingest applied events`);
    assert.equal(report.duplicates.length, EVENTS.length, `${point}: re-ingest not idempotent`);
    assert.deepEqual(snapshot(dir).lots, expected.lots, `${point}: state changed after re-ingest`);
  }
});

test('crash before first event is persisted loses nothing (inbox replay)', () => {
  const dir = tmpdir();
  const crashed = runCli(['ingest', '--dir', dir, '--file', inputFile(EVENTS)], {
    env: { EVENT_TRACE_FAULT: 'before-log' },
  });
  assert.equal(crashed.status, 99);
  assert.equal(readJsonl(path.join(dir, 'events.log')).length, 0);
  const resumed = runCli(['resume', '--dir', dir]);
  assert.equal(resumed.status, 0);
  const report = JSON.parse(resumed.stdout);
  assert.equal(report.inboxProcessed, EVENTS.length);
  assert.equal(readJsonl(path.join(dir, 'events.log')).length, EVENTS.length);
});
