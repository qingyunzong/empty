'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runCli } = require('../testlib/cli-runner');
const lineage = require('../src/lineage');

function buildWith(events) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'food-trace-'));
  const input = path.join(dir, 'events.jsonl');
  fs.writeFileSync(input, events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return runCli(['build', '--input', input, '--state', path.join(dir, 'state.json')]);
}

test('cycle exits with code 6', () => {
  const result = buildWith([
    { type: 'mix', output: 'A', inputs: ['B'] },
    { type: 'mix', output: 'B', inputs: ['A'] },
  ]);
  assert.equal(result.status, 6, result.stderr);
  assert.match(result.stderr, /cycle/);
});

test('dangling batch reference exits with code 7', () => {
  const mix = buildWith([
    { type: 'intake', batch: 'RM-1' },
    { type: 'mix', output: 'B-1', inputs: ['RM-1', 'GHOST'] },
  ]);
  assert.equal(mix.status, 7, mix.stderr);

  const inspect = buildWith([
    { type: 'intake', batch: 'RM-1' },
    { type: 'inspect', id: 'IN-1', batch: 'GHOST', test: 't', status: 'fail' },
  ]);
  assert.equal(inspect.status, 7, inspect.stderr);

  const scrap = buildWith([
    { type: 'intake', batch: 'RM-1' },
    { type: 'scrap', batch: 'GHOST' },
  ]);
  assert.equal(scrap.status, 7, scrap.stderr);
});

test('correcting an unknown inspection exits with code 7', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'food-trace-'));
  const input = path.join(dir, 'events.jsonl');
  const state = path.join(dir, 'state.json');
  fs.writeFileSync(input, JSON.stringify({ type: 'intake', batch: 'RM-1' }) + '\n');
  runCli(['build', '--input', input, '--state', state]);
  const result = runCli(['correct', '--state', state, '--inspection', 'NOPE', '--status', 'fail']);
  assert.equal(result.status, 7, result.stderr);
});

test('unknown inspection status is recorded as unknown, never as fail', () => {
  const state = lineage.buildState([
    { type: 'intake', batch: 'RM-1' },
    { type: 'inspect', id: 'IN-1', batch: 'RM-1', test: 't', status: 'weird-value' },
    { type: 'mix', output: 'B-1', inputs: ['RM-1'] },
  ]);
  const inspection = state.inspections.get('IN-1');
  assert.equal(lineage.effectiveStatus(inspection), 'unknown');
  assert.equal(lineage.normalizeStatus('weird-value'), 'unknown');
  assert.equal(state.contaminated.size, 0, 'unknown must not contaminate');
});
