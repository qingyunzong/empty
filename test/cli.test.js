'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const CLI = path.join(__dirname, '..', 'cli.js');

function setup(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'filljoin-'));
  const paths = {};
  for (const [name, lines] of Object.entries(files)) {
    paths[name] = path.join(dir, name);
    fs.writeFileSync(paths[name], lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  }
  paths.out = path.join(dir, 'out.jsonl');
  return paths;
}

// NOTE: this sandbox drops piped stdio of short-lived children, so the
// helper captures stdout/stderr through temp files instead of pipes.
function runCli(args) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'filljoin-io-'));
  const stdoutPath = path.join(dir, 'stdout');
  const stderrPath = path.join(dir, 'stderr');
  const res = spawnSync(process.execPath, [CLI, ...args], {
    stdio: ['ignore', fs.openSync(stdoutPath, 'w'), fs.openSync(stderrPath, 'w')],
  });
  return {
    status: res.status,
    stdout: fs.readFileSync(stdoutPath, 'utf8'),
    stderr: fs.readFileSync(stderrPath, 'utf8'),
  };
}

const TRADES = [
  { orderId: 'o1', symbol: 'A', qty: 100, price: 500, ts: 1_000 },
  { orderId: 'o2', symbol: 'B', qty: 50, price: 100, ts: 5_000 },
];
const CANCELS = [
  { orderId: 'o1', symbol: 'A', qty: 40, ts: 2_000 },
  { orderId: 'o1', symbol: 'A', qty: 30, ts: 11_000 },
  { orderId: 'o9', symbol: 'A', qty: 10, ts: 3_000 },
];

test('join command writes fills.jsonl and prints summary, exit 0', () => {
  const p = setup({ 't.jsonl': TRADES, 'c.jsonl': CANCELS });
  const res = runCli(['join', '--trades', p['t.jsonl'], '--cancels', p['c.jsonl'], '--out', p.out]);
  assert.equal(res.status, 0, res.stderr);

  const rows = fs.readFileSync(p.out, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(rows.map(({ orderId, qty, win }) => ({ orderId, qty, win })), [
    { orderId: 'o1', qty: 60, win: 0 },
    { orderId: 'o2', qty: 50, win: 0 },
    { orderId: 'o1', qty: -30, win: 1 },
  ]);
  assert.equal(rows[2].late, true);
  for (const row of rows) {
    assert.match(row.proof, /^[0-9a-f]{64}$/);
  }

  const summary = JSON.parse(res.stdout);
  assert.deepEqual(summary.symbols, {
    A: { qty: 30, amountCents: 15_000 },
    B: { qty: 50, amountCents: 5_000 },
  });
  assert.equal(summary.orphans.length, 1);
  assert.equal(summary.orphans[0].orderId, 'o9');
});

test('orphan cancels do not fail the run', () => {
  const p = setup({
    't.jsonl': [],
    'c.jsonl': [{ orderId: 'o9', symbol: 'A', qty: 10, ts: 3_000 }],
  });
  const res = runCli(['join', '--trades', p['t.jsonl'], '--cancels', p['c.jsonl'], '--out', p.out]);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(JSON.parse(res.stdout).orphans.length, 1);
});

test('missing field exits 2', () => {
  const p = setup({
    't.jsonl': [{ orderId: 'o1', symbol: 'A', qty: 100, ts: 1_000 }], // no price
    'c.jsonl': [],
  });
  const res = runCli(['join', '--trades', p['t.jsonl'], '--cancels', p['c.jsonl'], '--out', p.out]);
  assert.equal(res.status, 2);
  assert.match(res.stderr, /missing field "price"/);
});

test('qty <= 0 exits 2', () => {
  const p = setup({
    't.jsonl': TRADES,
    'c.jsonl': [{ orderId: 'o1', symbol: 'A', qty: 0, ts: 2_000 }],
  });
  const res = runCli(['join', '--trades', p['t.jsonl'], '--cancels', p['c.jsonl'], '--out', p.out]);
  assert.equal(res.status, 2);
  assert.match(res.stderr, /invalid qty/);
});

test('non-integer-cents price exits 2', () => {
  const p = setup({
    't.jsonl': [{ orderId: 'o1', symbol: 'A', qty: 1, price: 10.5, ts: 1_000 }],
    'c.jsonl': [],
  });
  const res = runCli(['join', '--trades', p['t.jsonl'], '--cancels', p['c.jsonl'], '--out', p.out]);
  assert.equal(res.status, 2);
  assert.match(res.stderr, /integer cents/);
});

test('bad usage and unreadable files exit 2', () => {
  assert.equal(runCli([]).status, 2);
  assert.equal(runCli(['join']).status, 2);
  const res = runCli(['join', '--trades', '/nonexistent', '--cancels', '/nonexistent', '--out', '/tmp/x.jsonl']);
  assert.equal(res.status, 2);
  assert.match(res.stderr, /cannot read/);
});
