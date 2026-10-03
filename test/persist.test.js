'use strict';
// Acceptance 5: persistence failure point is a torn queue-index write;
// after restart the index must be rebuilt consistently from the event log.
// (Child-process spawning is unavailable in the sandbox, so the CLI is driven
// through its exported run() entry — the same code path as `node cli.js`.)
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { run } = require('../cli.js');

const EVENTS = [
  { type: 'trade', id: 'T1', pair: 'EUR/USD', amount: 100, rate: 2, valueDate: '2026-10-05', maturity: '2026-10-05T09:00:00Z' },
  { type: 'trade', id: 'T2', pair: 'EUR/USD', amount: 50, rate: 2, valueDate: '2026-10-05', maturity: '2026-10-05T10:00:00Z' },
  { type: 'liquidity', ccy: 'USD', date: '2026-10-05', amount: 250 },
  { type: 'cancel', id: 'T2', amount: 20 },
  { type: 'calendar', version: 1, holidays: ['2026-10-05'] },
];

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fxstate-'));
const INPUT = EVENTS.map((e) => JSON.stringify(e)).join('\n') + '\n';

test('apply then replay are identical; torn index is rebuilt consistently', () => {
  const stateDir = path.join(tmpdir(), 'st');

  const applied = run(['apply', '--state', stateDir], INPUT);
  assert.equal(applied.code, 0, applied.stderr);

  const replay1 = run(['replay', '--state', stateDir], '');
  assert.equal(replay1.code, 0, replay1.stderr);
  assert.equal(replay1.stdout, applied.stdout, 'replay must reproduce apply output');

  // Simulate crash mid-index-update: truncate index.json.
  const idxFile = path.join(stateDir, 'index.json');
  const raw = fs.readFileSync(idxFile, 'utf8');
  fs.writeFileSync(idxFile, raw.slice(0, Math.floor(raw.length / 2)));

  const replay2 = run(['replay', '--state', stateDir], '');
  assert.equal(replay2.code, 0, replay2.stderr);
  assert.match(replay2.stderr, /rebuilding/);
  assert.equal(replay2.stdout, replay1.stdout, 'rebuilt index must match');

  // Index file itself is restored and consistent with the rebuilt state.
  const idx = JSON.parse(fs.readFileSync(idxFile, 'utf8'));
  const proof = JSON.parse(replay2.stdout.trim().split('\n')[2]);
  assert.equal(idx.head, proof.head);
  assert.equal(idx.events, proof.events);

  // Corrupt (valid JSON, wrong hash) index is also detected and rebuilt.
  fs.writeFileSync(idxFile, JSON.stringify({ events: 1, head: 'x', buckets: {}, indexHash: 'bad' }));
  const replay3 = run(['replay', '--state', stateDir], '');
  assert.equal(replay3.code, 0);
  assert.equal(replay3.stdout, replay1.stdout);
});

test('CLI errors go to stderr with exit code 7', () => {
  const bad = run(['apply', '--state', path.join(tmpdir(), 'a')], '{not json}\n');
  assert.equal(bad.code, 7);
  assert.match(bad.stderr, /ERROR BAD_JSON/);
  assert.equal(bad.stdout, '');

  const noTrade = run(['apply', '--state', path.join(tmpdir(), 'b')],
    JSON.stringify({ type: 'cancel', id: 'NOPE' }) + '\n');
  assert.equal(noTrade.code, 7);
  assert.match(noTrade.stderr, /ERROR NO_TRADE/);

  const usage = run(['frobnicate'], '');
  assert.equal(usage.code, 7);
  assert.match(usage.stderr, /ERROR USAGE/);
});

test('proof is replay-stable across independent state dirs', () => {
  const r1 = run(['apply', '--state', path.join(tmpdir(), 'st')], INPUT);
  const r2 = run(['apply', '--state', path.join(tmpdir(), 'st')], INPUT);
  assert.equal(r1.stdout, r2.stdout, 'same log -> same deliverable/exposure/proof');
});
