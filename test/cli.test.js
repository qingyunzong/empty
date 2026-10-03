import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.js');

function setup(rules, events) {
  const dir = mkdtempSync(join(tmpdir(), 'sentinel-'));
  const rulesPath = join(dir, 'rules.dsl');
  const eventsPath = join(dir, 'events.jsonl');
  const outPath = join(dir, 'result.json');
  writeFileSync(rulesPath, rules);
  writeFileSync(eventsPath, events);
  return { rulesPath, eventsPath, outPath };
}

function run(args) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
}

const RULES = 'alert overheat level critical on devices(/^dev-/) when temp > 80C for 5m\n';
const EVENTS = [
  { id: 'e1', time: 0, device: 'dev-1', type: 'temp', value: 85 },
  { id: 'e2', time: 600000, device: 'dev-1', type: 'temp', value: 70 },
].map((e) => JSON.stringify(e)).join('\n') + '\n';

test('success: exit 0 and result JSON with alert/withdraw records', () => {
  const { rulesPath, eventsPath, outPath } = setup(RULES, EVENTS);
  const res = run(['run', rulesPath, eventsPath, '--out', outPath]);
  assert.equal(res.status, 0, res.stderr);
  const result = JSON.parse(readFileSync(outPath, 'utf8'));
  assert.equal(result.ok, true);
  assert.deepEqual(result.stats, { events: 2, alerts: 1, withdrawals: 1, errors: 0 });
  assert.deepEqual(result.records.map((r) => r.type), ['alert', 'withdraw']);
});

test('DSL error: exit 2 with line:col diagnostic, no result file', () => {
  const { rulesPath, eventsPath, outPath } = setup(
    'let x = 1\nalert r level info on devices(d1) when temp > 80A\n',
    EVENTS,
  );
  const res = run(['run', rulesPath, eventsPath, '--out', outPath]);
  assert.equal(res.status, 2);
  assert.match(res.stderr, /rules\.dsl:2:45: error: unit mismatch/);
  assert.equal(existsSync(outPath), false);
});

test('domain error: exit 2, JSON error written, processed events deterministic', () => {
  const events = EVENTS + JSON.stringify({ id: 'r1', retracts: 'ghost' }) + '\n';
  const { rulesPath, eventsPath, outPath } = setup(RULES, events);
  const first = run(['run', rulesPath, eventsPath, '--out', outPath]);
  assert.equal(first.status, 2);
  assert.match(first.stderr, /event #3: error: unknown event id 'ghost' in retracts/);
  const result = JSON.parse(readFileSync(outPath, 'utf8'));
  assert.equal(result.ok, false);
  assert.deepEqual(result.errors, [{ seq: 3, error: "unknown event id 'ghost' in retracts" }]);
  assert.equal(result.records.length, 2); // valid events still produced records
  // deterministic: re-run yields byte-identical output
  const outPath2 = outPath + '.2';
  const second = run(['run', rulesPath, eventsPath, '--out', outPath2]);
  assert.equal(second.status, 2);
  assert.equal(readFileSync(outPath2, 'utf8'), readFileSync(outPath, 'utf8'));
});

test('invalid JSONL line: exit 2 with event sequence number', () => {
  const { rulesPath, eventsPath, outPath } = setup(RULES, EVENTS + '{not json}\n');
  const res = run(['run', rulesPath, eventsPath, '--out', outPath]);
  assert.equal(res.status, 2);
  const result = JSON.parse(readFileSync(outPath, 'utf8'));
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].seq, 3);
  assert.match(result.errors[0].error, /invalid JSON/);
});

test('usage and missing files: exit 1', () => {
  assert.equal(run([]).status, 1);
  assert.equal(run(['run', '/nonexistent.dsl', '/nonexistent.jsonl']).status, 1);
});
