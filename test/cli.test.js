'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { run } = require('../src/cli');

function runCli(argv, input) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leaderboard-cli-'));
  const file = path.join(dir, 'events.jsonl');
  fs.writeFileSync(file, input);

  let stdout = '';
  let stderr = '';
  const originalOut = process.stdout.write;
  const originalErr = process.stderr.write;
  process.stdout.write = (chunk) => { stdout += chunk; return true; };
  process.stderr.write = (chunk) => { stderr += chunk; return true; };
  let status;
  try {
    status = run(['node', 'src/cli.js', ...argv, '--in', file]);
  } finally {
    process.stdout.write = originalOut;
    process.stderr.write = originalErr;
  }
  return { status, stdout, stderr };
}

function jsonLines(text) {
  return text.split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

test('clean stream: actions on stdout, empty stderr, exit code 0', () => {
  const input = [
    JSON.stringify({ type: 'TRIGGER', eventId: 'e1', version: 1, op: 'UPSERT', channel: 'alpha', ts: 100, charge: 5 }),
    JSON.stringify({ type: 'TRIGGER', eventId: 'e2', version: 1, op: 'UPSERT', channel: 'beta', ts: 200, charge: 9 }),
    JSON.stringify({ type: 'WATERMARK', ts: 600000 }),
    '',
  ].join('\n');
  const result = runCli(['triggers'], input);
  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  const actions = jsonLines(result.stdout);
  assert.deepEqual(actions.map((a) => a.type), ['ADD', 'WITHDRAW', 'ADD']);
  assert.equal(actions[2].top[0].channel, 'beta');
  assert.equal(actions[2].certificate.totals.alpha, 5);
  assert.equal(actions[2].certificate.totals.beta, 9);
});

test('errors go to stderr as JSON and exit code is 2, valid events still processed', () => {
  const input = [
    JSON.stringify({ type: 'TRIGGER', eventId: 'e1', version: 2, op: 'UPSERT', channel: 'alpha', ts: 100, charge: 5 }),
    'not json',
    JSON.stringify({ type: 'TRIGGER', eventId: 'e1', version: 1, op: 'UPSERT', channel: 'alpha', ts: 100, charge: 6 }),
    JSON.stringify({ type: 'TRIGGER', eventId: 'ghost', version: 1, op: 'RETRACT' }),
    JSON.stringify({ type: 'TRIGGER', eventId: 'e2', version: 1, op: 'UPSERT', channel: 'beta', ts: 100, charge: -3 }),
    JSON.stringify({ type: 'WATERMARK', ts: 600000 }),
    JSON.stringify({ type: 'TRIGGER', eventId: 'e3', version: 1, op: 'UPSERT', channel: 'gamma', ts: 100, charge: 1 }),
    JSON.stringify({ type: 'TRIGGER', eventId: 'e1', version: 3, op: 'RETRACT' }),
    '',
  ].join('\n');
  const result = runCli(['triggers'], input);
  assert.equal(result.status, 2);
  const errors = jsonLines(result.stderr);
  assert.deepEqual(
    errors.map((e) => e.code),
    ['INVALID_JSON', 'STALE_VERSION', 'UNKNOWN_RETRACT', 'INVALID_CHARGE', 'LATE', 'LATE'],
  );
  assert.deepEqual(errors.map((e) => e.line), [2, 3, 4, 5, 7, 8]);
  for (const error of errors) {
    assert.equal(typeof error.message, 'string');
  }
  const actions = jsonLines(result.stdout);
  assert.deepEqual(actions.map((a) => a.type), ['ADD']);
  assert.deepEqual(actions[0].top, [{ channel: 'alpha', total: 5 }]);
});

test('usage and IO errors exit with code 2 and JSON on stderr', () => {
  let stderr = '';
  const originalErr = process.stderr.write;
  process.stderr.write = (chunk) => { stderr += chunk; return true; };
  let usageStatus;
  let ioStatus;
  try {
    usageStatus = run(['node', 'src/cli.js']);
    ioStatus = run(['node', 'src/cli.js', 'triggers', '--in', '/nonexistent/events.jsonl']);
  } finally {
    process.stderr.write = originalErr;
  }
  assert.equal(usageStatus, 2);
  assert.equal(ioStatus, 2);
  const codes = jsonLines(stderr).map((e) => e.code);
  assert.deepEqual(codes, ['USAGE', 'IO_ERROR']);
});
