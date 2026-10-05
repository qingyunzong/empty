'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { main } = require('../cli');

// The CLI is exercised in-process via its exported main(argv, io);
// the thin `require.main` wrapper only maps the return value to exitCode.

function runCli(args) {
  let stdout = '';
  let stderr = '';
  const status = main(args, {
    out: (s) => { stdout += s + '\n'; },
    err: (s) => { stderr += s + '\n'; },
  });
  return { status, stdout, stderr };
}

function withOps(ops, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-'));
  const file = path.join(dir, 'ops.json');
  fs.writeFileSync(file, JSON.stringify({ ops }));
  try {
    return fn(file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('CLI happy path: exit 0, plan sorted by (start, id)', () => {
  const res = runCli(['examples/ops.json', '--cap', '100', '--seed', '7']);
  assert.equal(res.status, 0, res.stderr);
  const report = JSON.parse(res.stdout);
  assert.equal(report.ok, true);
  assert.equal(report.cap, 100);
  assert.equal(report.used, 70);
  assert.deepEqual(
    report.plan.map((j) => [j.id, j.start]),
    [['C', 7], ['A', 9]]
  );
  assert.ok(Array.isArray(report.ledger));
  assert.ok(Array.isArray(report.pending));
});

test('CLI budget insufficient: exit 5, state unchanged', () => {
  withOps(
    [
      { op: 'PLAN', id: 'A', ver: 1, cost: 80 },
      { op: 'PLAN', id: 'B', ver: 1, cost: 30 },
    ],
    (file) => {
      const res = runCli([file, '--cap', '100']);
      assert.equal(res.status, 5, res.stderr);
      assert.match(res.stderr, /budget insufficient/);
      const report = JSON.parse(res.stdout);
      assert.equal(report.ok, false);
      assert.equal(report.used, 80, 'failed PLAN left no trace');
      assert.deepEqual(report.plan.map((j) => j.id), ['A']);
      assert.deepEqual(report.remaining.map((c) => c.op), ['PLAN']);
    }
  );
});

test('CLI protocol error: exit 3', () => {
  withOps([{ op: 'CANCEL', id: 'GHOST', ver: 1 }], (file) => {
    const res = runCli([file, '--cap', '100']);
    assert.equal(res.status, 3, res.stderr);
    assert.match(res.stderr, /protocol error/);
  });
});

test('CLI malformed op: exit 3', () => {
  withOps([{ op: 'FROBNICATE', id: 'A', ver: 1 }], (file) => {
    const res = runCli([file, '--cap', '100']);
    assert.equal(res.status, 3, res.stderr);
  });
});

test('CLI usage error: exit 2', () => {
  assert.equal(runCli([]).status, 2);
  assert.equal(runCli(['examples/ops.json']).status, 2);
  assert.equal(runCli(['no-such-file.json', '--cap', '1']).status, 2);
});

test('CLI seeded loss run stays consistent', () => {
  const res = runCli(['examples/ops.json', '--cap', '100', '--seed', '42', '--loss', '0.4']);
  assert.equal(res.status, 0, res.stderr);
  const report = JSON.parse(res.stdout);
  assert.equal(report.used, 70);
  assert.ok(report.stats.retransmissions > 0);
});
