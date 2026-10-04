import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../src/cli.js';

// Spawning a child process is not always permitted, so the CLI is tested
// in-process: run() is pure with respect to argv and writes only to
// process.stdout / process.stderr, which are captured here.

function capture(fn) {
  const out = [];
  const err = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = (chunk) => { out.push(String(chunk)); return true; };
  process.stderr.write = (chunk) => { err.push(String(chunk)); return true; };
  let code;
  try {
    code = fn();
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
  return { code, stdout: out.join(''), stderr: err.join('') };
}

function withDataFile(lines, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'sessions-cli-'));
  const file = join(dir, 'data.jsonl');
  writeFileSync(file, lines.join('\n') + '\n');
  return fn(file);
}

const T0 = Date.parse('2026-01-01T00:00:00Z');
const iso = (minute) => new Date(T0 + minute * 60 * 1000).toISOString();
const up = (id, station, minute, temp, version = 1) =>
  JSON.stringify({ op: 'UPSERT', id, station, eventTime: iso(minute), temp, version });
const wm = (minute) => JSON.stringify({ op: 'WATERMARK', ts: iso(minute) });

test('CLI prints finalized sessions as JSONL on stdout, exit 0', () => {
  const result = withDataFile([
    up('a', 's1', 0, 10),
    up('b', 's1', 5, 20),
    wm(16),
  ], (file) => capture(() => run(['sessions', '--in', file])));
  assert.equal(result.code, 0);
  assert.equal(result.stderr, '');
  const rows = result.stdout.trim().split('\n').map(JSON.parse);
  assert.deepEqual(rows, [{
    station: 's1',
    start: '2026-01-01T00:00:00.000Z',
    end: '2026-01-01T00:05:00.000Z',
    count: 2,
    avgTemp: 15,
    ids: ['a', 'b'],
    version: 1,
  }]);
});

test('CLI reports record errors as JSON on stderr and keeps going', () => {
  const result = withDataFile([
    up('a', 's1', 0, 10),
    wm(11),
    up('b', 's1', 5, 20), // LATE
    JSON.stringify({ op: 'RETRACT', id: 'ghost', version: 1 }), // UNKNOWN_RETRACT
    up('c', 's1', 30, 30),
    wm(41),
  ], (file) => capture(() => run(['sessions', '--in', file])));
  assert.equal(result.code, 0);
  const errs = result.stderr.trim().split('\n').map(JSON.parse);
  assert.deepEqual(errs.map((e) => e.error), ['LATE', 'UNKNOWN_RETRACT']);
  assert.deepEqual(errs.map((e) => e.line), [3, 4]);
  const rows = result.stdout.trim().split('\n').map(JSON.parse);
  assert.deepEqual(rows.map((r) => r.ids), [['a'], ['c']]);
});

test('CLI exits 2 on malformed JSON input', () => {
  const result = withDataFile([
    up('a', 's1', 0, 10),
    '{not json',
  ], (file) => capture(() => run(['sessions', '--in', file])));
  assert.equal(result.code, 2);
  const err = JSON.parse(result.stderr.trim().split('\n').at(-1));
  assert.equal(err.fatal, true);
  assert.equal(err.error, 'INVALID_JSON');
  assert.equal(err.line, 2);
});

test('CLI exits 2 on invalid record shape', () => {
  const result = withDataFile([
    JSON.stringify({ op: 'UPSERT', id: 'a', station: 's1', eventTime: iso(0), temp: 'hot', version: 1 }),
  ], (file) => capture(() => run(['sessions', '--in', file])));
  assert.equal(result.code, 2);
  const err = JSON.parse(result.stderr.trim());
  assert.equal(err.fatal, true);
  assert.equal(err.error, 'INVALID_RECORD');
});

test('CLI exits 2 on missing file and on bad usage', () => {
  assert.equal(capture(() => run(['sessions', '--in', '/no/such/file.jsonl'])).code, 2);
  assert.equal(capture(() => run(['sessions'])).code, 2);
  assert.equal(capture(() => run(['bogus', '--in', 'x'])).code, 2);
});
