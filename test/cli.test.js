'use strict';

// The sandbox forbids spawning a node subprocess from within node, so the
// CLI is exercised in-process through its exported run(argv, io) entry point
// with captured stdout/stderr; exit codes are the real return values.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { run } = require('../src/cli');

function writeLog(lines) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'events-')), 'events.jsonl');
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return file;
}

function runCli(args) {
  let stdout = '';
  let stderr = '';
  const status = run(['node', 'src/cli.js', ...args], {
    stdout: (s) => { stdout += s; },
    stderr: (s) => { stderr += s; },
  });
  return { status, stdout, stderr };
}

test('cli: clean log exits 0 and streams JSONL ranking actions on stdout', () => {
  const file = writeLog([
    JSON.stringify({ type: 'TRIGGER', eventId: 'e1', version: 1, op: 'UPSERT', channel: 'a', ts: 0, charge: 1 }),
    JSON.stringify({ type: 'TRIGGER', eventId: 'e2', version: 1, op: 'UPSERT', channel: 'b', ts: 1, charge: 2 }),
    JSON.stringify({ type: 'WATERMARK', ts: 600000 }),
  ]);
  const res = runCli(['triggers', '--in', file]);
  assert.equal(res.status, 0);
  assert.equal(res.stderr, '');
  const actions = res.stdout.trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(actions.length >= 2);
  for (const a of actions) {
    assert.ok(a.type === 'ADD' || a.type === 'WITHDRAW');
    assert.ok(Array.isArray(a.top3));
    assert.ok(a.certificate && Array.isArray(a.certificate.eventIds));
  }
  const last = actions[actions.length - 1];
  assert.deepEqual(last.top3, [
    { channel: 'b', total: 2 },
    { channel: 'a', total: 1 },
  ]);
});

test('cli: bad records produce JSON errors on stderr and exit code 2', () => {
  const file = writeLog([
    JSON.stringify({ type: 'TRIGGER', eventId: 'e1', version: 1, op: 'UPSERT', channel: 'a', ts: 0, charge: 1 }),
    JSON.stringify({ type: 'TRIGGER', eventId: 'e1', version: 1, op: 'UPSERT', channel: 'a', ts: 0, charge: 5 }),
    JSON.stringify({ type: 'TRIGGER', eventId: 'ghost', version: 1, op: 'RETRACT' }),
    JSON.stringify({ type: 'TRIGGER', eventId: 'e2', version: 1, op: 'UPSERT', channel: 'b', ts: 0, charge: -3 }),
    '{"type":"TRIGGER",broken',
    JSON.stringify({ type: 'WATERMARK', ts: 600000 }),
    JSON.stringify({ type: 'TRIGGER', eventId: 'e3', version: 1, op: 'UPSERT', channel: 'c', ts: 5, charge: 1 }),
  ]);
  const res = runCli(['triggers', '--in', file]);
  assert.equal(res.status, 2);
  const errors = res.stderr.trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(
    errors.map((e) => e.error),
    ['STALE_VERSION', 'UNKNOWN_RETRACT', 'INVALID_CHARGE', 'PARSE_ERROR', 'LATE']
  );
  for (const e of errors) assert.equal(typeof e.line, 'number');
  // valid events still produced actions on stdout
  assert.ok(res.stdout.includes('"type":"ADD"'));
});

test('cli: usage problems exit 2 with a JSON error', () => {
  const noCmd = runCli([]);
  assert.equal(noCmd.status, 2);
  JSON.parse(noCmd.stderr.trim());

  const noIn = runCli(['triggers']);
  assert.equal(noIn.status, 2);
  assert.equal(JSON.parse(noIn.stderr.trim()).error, 'USAGE');

  const missing = runCli(['triggers', '--in', '/nonexistent/events.jsonl']);
  assert.equal(missing.status, 2);
  assert.equal(JSON.parse(missing.stderr.trim()).error, 'IO_ERROR');
});
