import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.js');

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'oee-cli-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function cli(args, { input } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args]);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
    if (input !== undefined) {
      child.stdin.write(input);
    }
    child.stdin.end();
  });
}

const EVENTS = [
  { type: 'count', id: 'c1', terminal: 'A', key: 'produced', delta: 200 },
  { type: 'count', id: 'c2', terminal: 'B', key: 'produced', delta: 150 },
  { type: 'count', id: 'c3', terminal: 'A', key: 'rejected', delta: 10 },
  { type: 'down', id: 'd1', start: '2026-10-05T09:00:00Z', end: '2026-10-05T09:30:00Z' },
];

function jsonl(events) {
  return events.map((e) => JSON.stringify(e)).join('\n') + '\n';
}

test('ingest -> merge -> oee roundtrip over two terminal files', async () => {
  const fileA = join(dir, 'a.jsonl');
  const fileB = join(dir, 'b.jsonl');
  writeFileSync(fileA, jsonl([EVENTS[0], EVENTS[2], EVENTS[3]]));
  writeFileSync(fileB, jsonl([EVENTS[1], EVENTS[3]])); // d1 duplicated across terminals

  const merged = join(dir, 'merged.jsonl');
  const merge = await cli(['merge', merged, fileA, fileB, '--digest']);
  assert.equal(merge.status, 0, merge.stderr);
  const report = JSON.parse(merge.stdout);
  assert.equal(report.merged.count, 4); // duplicate d1 absorbed
  assert.deepEqual(report.inputs[1].missing.sort(), ['c1', 'c3']);

  const oee = await cli(['oee', merged, '--planned', '480', '--rate', '1',
    '--shift-start', '2026-10-05T08:00:00Z', '--shift-end', '2026-10-05T16:00:00Z']);
  assert.equal(oee.status, 0, oee.stderr);
  const result = JSON.parse(oee.stdout);
  assert.equal(result.produced, 350);
  assert.equal(result.rejected, 10);
  assert.equal(result.downtimeMinutes, 30);
  assert.ok(Math.abs(result.available - 450 / 480) < 1e-12);
  assert.deepEqual(result.pending, []);
});

test('ingest appends stdin events to a store', async () => {
  const store = join(dir, 's.jsonl');
  const first = await cli(['ingest', store], { input: jsonl([EVENTS[0]]) });
  assert.equal(first.status, 0, first.stderr);
  const second = await cli(['ingest', store], { input: jsonl([EVENTS[0], EVENTS[1]]) });
  assert.equal(second.status, 0, second.stderr);
  const lines = readFileSync(store, 'utf8').trim().split('\n');
  assert.equal(lines.length, 2); // c1 deduped
});

test('negative count exits 10', async () => {
  const store = join(dir, 's.jsonl');
  const bad = { type: 'count', id: 'bad', terminal: 'A', key: 'produced', delta: -5 };
  const res = await cli(['ingest', store], { input: jsonl([bad]) });
  assert.equal(res.status, 10);
  assert.match(res.stderr, /negative count/);
  assert.equal(existsSync(store), false); // nothing persisted
});

test('out-of-skew events are held; oee exits 11 while hold is pending', async () => {
  const store = join(dir, 's.jsonl');
  const now = '2026-10-05T16:00:00Z';
  const skewed = { type: 'down', id: 'late', start: '2026-10-05T10:00:00Z', end: '2026-10-05T11:00:00Z', ts: '2026-10-05T10:00:00Z' };
  const ok = { type: 'count', id: 'c1', terminal: 'A', key: 'produced', delta: 100, ts: '2026-10-05T15:59:00Z' };

  const ingest = await cli(['ingest', store, '--now', now], { input: jsonl([ok, skewed]) });
  assert.equal(ingest.status, 0, ingest.stderr);
  assert.deepEqual(JSON.parse(ingest.stdout), { ingested: 1, held: 1 });

  const hold = await cli(['hold', store]);
  assert.equal(hold.status, 11);
  const pending = JSON.parse(hold.stdout).pending;
  assert.equal(pending.length, 1);
  assert.equal(pending[0].id, 'late');

  const oee = await cli(['oee', store, '--planned', '480', '--rate', '1']);
  assert.equal(oee.status, 11);
  assert.match(oee.stderr, /pending/);

  const forced = await cli(['oee', store, '--planned', '480', '--rate', '1', '--allow-pending']);
  assert.equal(forced.status, 0, forced.stderr);
  const result = JSON.parse(forced.stdout);
  assert.equal(result.downtimeMinutes, 0); // held downtime excluded from loss
  assert.deepEqual(result.pending, ['late']);
});

test('merge output is canonical regardless of input order', async () => {
  const fileA = join(dir, 'a.jsonl');
  const fileB = join(dir, 'b.jsonl');
  writeFileSync(fileA, jsonl([EVENTS[0], EVENTS[1]]));
  writeFileSync(fileB, jsonl([EVENTS[2], EVENTS[3]]));
  const out1 = join(dir, 'm1.jsonl');
  const out2 = join(dir, 'm2.jsonl');
  assert.equal((await cli(['merge', out1, fileA, fileB])).status, 0);
  assert.equal((await cli(['merge', out2, fileB, fileA])).status, 0);
  assert.equal(readFileSync(out1, 'utf8'), readFileSync(out2, 'utf8'));
});
