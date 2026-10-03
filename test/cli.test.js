'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runCli } = require('../index');

const order = (id, status, assignee = null, priority = 'low') => ({
  id,
  status,
  assignee,
  priority,
});

function setup(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orders-cli-'));
  const paths = {};
  for (const [name, data] of Object.entries(files)) {
    paths[name] = path.join(dir, `${name}.json`);
    fs.writeFileSync(paths[name], JSON.stringify(data));
  }
  paths.out = path.join(dir, 'out.json');
  return paths;
}

function run(args) {
  const captured = { stdout: '', stderr: '' };
  const status = runCli(args, {
    stdout: (text) => {
      captured.stdout += text;
    },
    stderr: (text) => {
      captured.stderr += text;
    },
  });
  return { status, ...captured };
}

test('CLI merge-orders: clean merge exits 0 and writes --out', () => {
  const p = setup({
    base: [order('a', 'assigned', 'amy', 'low')],
    local: [order('a', 'assigned', 'bob', 'low')],
    remote: [order('a', 'assigned', 'amy', 'high')],
  });
  const res = run(['merge-orders', '--base', p.base, '--local', p.local, '--remote', p.remote, '--out', p.out]);
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(p.out, 'utf8')), [order('a', 'assigned', 'bob', 'high')]);
});

test('CLI merge-orders: conflict exits 1 and writes no output file', () => {
  const p = setup({
    base: [order('a', 'assigned', 'amy')],
    local: [order('a', 'assigned', 'bob')],
    remote: [order('a', 'assigned', 'carol')],
  });
  const res = run(['merge-orders', '--base', p.base, '--local', p.local, '--remote', p.remote, '--out', p.out]);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /both-modified/);
  assert.equal(fs.existsSync(p.out), false);
});

test('CLI merge-orders: unknown order exits 2', () => {
  const p = setup({
    base: [order('a', 'created')],
    local: [order('a', 'created')],
    remote: [order('a', 'created'), order('ghost', 'created')],
  });
  const res = run(['merge-orders', '--base', p.base, '--local', p.local, '--remote', p.remote]);
  assert.equal(res.status, 2);
  assert.match(res.stderr, /unknown order: ghost/);
});

test('CLI merge-orders: terminal-order modification exits 1', () => {
  const p = setup({
    base: [order('a', 'done', 'amy', 'high')],
    local: [order('a', 'in_progress', 'amy', 'high')],
    remote: [order('a', 'done', 'amy', 'critical')],
  });
  const res = run(['merge-orders', '--base', p.base, '--local', p.local, '--remote', p.remote]);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /terminal-order-modified/);
});

test('CLI apply: illegal patch exits 2', () => {
  const p = setup({
    orders: [order('a', 'created')],
    patch: { changes: [{ id: 'a', field: 'status', from: 'created', to: 'done' }] },
  });
  const res = run(['apply', '--orders', p.orders, '--patch', p.patch]);
  assert.equal(res.status, 2);
  assert.match(res.stderr, /illegal status transition/);
});

test('CLI diff/apply/undo/redo round-trip', () => {
  const p = setup({
    base: [order('a', 'created')],
    target: [order('a', 'assigned', 'amy')],
  });
  const diff = run(['diff', '--base', p.base, '--target', p.target, '--out', p.out]);
  assert.equal(diff.status, 0, diff.stderr);

  const applied = run(['apply', '--orders', p.base, '--patch', p.out]);
  assert.equal(applied.status, 0, applied.stderr);
  assert.deepEqual(JSON.parse(applied.stdout), [order('a', 'assigned', 'amy')]);

  const undone = run(['undo', '--orders', p.target, '--patch', p.out]);
  assert.equal(undone.status, 0, undone.stderr);
  assert.deepEqual(JSON.parse(undone.stdout), [order('a', 'created')]);

  const redone = run(['redo', '--orders', p.base, '--patch', p.out]);
  assert.equal(redone.status, 0, redone.stderr);
  assert.deepEqual(JSON.parse(redone.stdout), [order('a', 'assigned', 'amy')]);
});

test('CLI: missing option or unknown command exits 2', () => {
  assert.equal(run(['merge-orders', '--base', 'x.json']).status, 2);
  assert.equal(run(['frobnicate']).status, 2);
});
