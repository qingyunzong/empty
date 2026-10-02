'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { run } = require('../src/cli');

// The sandbox forbids spawning child processes, so the CLI is driven
// in-process through its injectable IO; bin/card.js is a thin wrapper.

function writeJsonl(lines) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'card-')), 'events.jsonl');
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return file;
}

function runCli(args) {
  let stdout = '';
  let stderr = '';
  const status = run(args, { writeStdout: (s) => { stdout += s; }, writeStderr: (s) => { stderr += s; } });
  return { status, stdout, stderr };
}

test('CLI: apply events and print merchant stats', () => {
  const file = writeJsonl([
    JSON.stringify({ type: 'auth', id: 't1', merchant: 'm', day: '2026-10-01', amount: 100, currency: 'USD', tip: 12 }),
    JSON.stringify({ type: 'auth', id: 't2', merchant: 'm', day: '2026-10-01', amount: 50, currency: 'XTS', tip: null }),
    JSON.stringify({ type: 'capture', id: 't1' }),
    JSON.stringify({ type: 'capture', id: 't2' }),
  ]);
  const res = runCli(['apply', file, '--stats', 'm', '2026-10-01']);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stderr, '');
  const out = JSON.parse(res.stdout);
  assert.equal(out.applied, 4);
  assert.equal(out.stats.merchant, 'm');
  assert.equal(out.stats.day, '2026-10-01');
  assert.equal(out.stats.buckets.USD.tipSum, 12);
  assert.equal(out.stats.buckets.XTS.sum, 50);
  assert.equal(out.stats.converted.sum, 100); // XTS not converted
});

test('CLI: illegal transition exits non-zero with {code,message} on stderr', () => {
  const file = writeJsonl([
    JSON.stringify({ type: 'auth', id: 't1', merchant: 'm', day: '2026-10-01', amount: 1, currency: 'USD', tip: null }),
    JSON.stringify({ type: 'refund', id: 't1' }),
  ]);
  const res = runCli(['apply', file]);
  assert.notEqual(res.status, 0);
  assert.equal(res.stdout, '');
  const err = JSON.parse(res.stderr);
  assert.equal(err.code, 'E_TRANSITION');
  assert.equal(typeof err.message, 'string');
});

test('CLI: malformed JSONL line reports E_PARSE with line number', () => {
  const file = writeJsonl([
    JSON.stringify({ type: 'auth', id: 't1', merchant: 'm', day: '2026-10-01', amount: 1, currency: 'USD', tip: null }),
    '{not json',
  ]);
  const res = runCli(['apply', file]);
  assert.notEqual(res.status, 0);
  const err = JSON.parse(res.stderr);
  assert.equal(err.code, 'E_PARSE');
  assert.match(err.message, /line 2/);
});

test('CLI: settlement-locked chargeback reversal fails via CLI', () => {
  const file = writeJsonl([
    JSON.stringify({ type: 'auth', id: 't1', merchant: 'm', day: '2026-10-01', amount: 1, currency: 'USD', tip: null }),
    JSON.stringify({ type: 'capture', id: 't1' }),
    JSON.stringify({ type: 'settle', merchant: 'm', day: '2026-10-01' }),
    JSON.stringify({ type: 'chargeback', id: 't1' }),
    JSON.stringify({ type: 'reverse_chargeback', id: 't1' }),
  ]);
  const res = runCli(['apply', file]);
  assert.notEqual(res.status, 0);
  assert.equal(JSON.parse(res.stderr).code, 'E_LOCKED');
});

test('CLI: usage errors exit non-zero', () => {
  for (const args of [[], ['apply'], ['bogus', 'x'], ['apply', 'f', '--stats', 'onlyone']]) {
    const res = runCli(args);
    assert.notEqual(res.status, 0);
    assert.equal(JSON.parse(res.stderr).code, 'E_USAGE');
  }
  const res = runCli(['apply', '/nonexistent/events.jsonl']);
  assert.notEqual(res.status, 0);
  assert.equal(JSON.parse(res.stderr).code, 'E_VALIDATION');
});
