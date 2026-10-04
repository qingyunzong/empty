'use strict';

// Acceptance B, at library level (the CLI serializes exactly these
// AuditError codes to {"error":{code,message}} and exits 1; nested process
// spawning is unavailable in this sandbox, so the CLI wrapper is exercised
// manually instead).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runAudit } = require('../lib/audit');
const { applyRules, undo } = require('../lib/state');
const { AuditError } = require('../lib/errors');

const GOOD_LINE = JSON.stringify({
  batch: 'B1', account: 'A100', currency: 'USD', amount: 10,
  direction: 'credit', timestamp: '2026-01-01T00:00:00Z',
});

function tmpStatePath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-err-'));
  return path.join(dir, 'state.json');
}

function assertCode(fn, code, pattern) {
  assert.throws(fn, (e) => {
    assert.ok(e instanceof AuditError, `expected AuditError, got ${e}`);
    assert.equal(e.code, code);
    if (pattern) assert.match(e.message, pattern);
    return true;
  });
}

test('acceptance B: invalid regex reports BAD_REGEX and writes no state', () => {
  for (const badPattern of ['a(b', 'x\\1y', 'a'.repeat(81), 'a+b', '\\d']) {
    assertCode(() => runAudit({ rules: [badPattern] }, GOOD_LINE + '\n'), 'BAD_REGEX');

    // apply must validate first and never persist a bad rule set.
    const state = tmpStatePath();
    assertCode(() => applyRules(state, { rules: [badPattern] }), 'BAD_REGEX');
    assert.equal(fs.existsSync(state), false, `state written for ${badPattern}`);
  }
});

test('acceptance B: out-of-range and malformed lines report BAD_LINE', () => {
  const badLines = [
    [JSON.stringify({ batch: 'B1', account: 'A', currency: 'USD', amount: 1e13, direction: 'credit', timestamp: '2026-01-01T00:00:00Z' }), /out of range/],
    [JSON.stringify({ batch: 'B1', account: 'A', currency: 'USD', amount: 1, direction: 'xfer', timestamp: '2026-01-01T00:00:00Z' }), /direction/],
    [JSON.stringify({ batch: 'B1', account: 'A', currency: 'usd', amount: 1, direction: 'credit', timestamp: '2026-01-01T00:00:00Z' }), /currency/],
    [JSON.stringify({ batch: 'B1', account: 'A', currency: 'USD', amount: 1, direction: 'credit', timestamp: 'not-a-date' }), /timestamp/],
    ['{"batch":"B1",broken', /invalid JSON/],
  ];
  for (const [bad, pattern] of badLines) {
    assertCode(
      () => runAudit({ rules: ['[^]*'] }, GOOD_LINE + '\n' + bad + '\n'),
      'BAD_LINE',
      /line 2/
    );
    assertCode(
      () => runAudit({ rules: ['[^]*'] }, bad + '\n'),
      'BAD_LINE',
      pattern
    );
  }
});

test('undo without a snapshot reports NO_SNAPSHOT', () => {
  assertCode(() => undo(tmpStatePath()), 'NO_SNAPSHOT');
});

test('conflicting rule actions report AMBIGUOUS_RULE, never a silent non-match', () => {
  const rules = {
    rules: [
      { id: 'r1', pattern: '[^]*USD[^]*', action: 'flag' },
      { id: 'r2', pattern: '[^]*credit[^]*', action: 'pass' },
    ],
  };
  assertCode(() => runAudit(rules, GOOD_LINE + '\n'), 'AMBIGUOUS_RULE', /line 1/);

  // Same-action overlaps are not conflicts.
  const ok = runAudit({
    rules: [
      { id: 'r1', pattern: '[^]*USD[^]*', action: 'flag' },
      { id: 'r2', pattern: '[^]*credit[^]*', action: 'flag' },
    ],
  }, GOOD_LINE + '\n');
  assert.equal(ok.match.count, 1);
});
