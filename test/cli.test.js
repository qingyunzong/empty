'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { run } = require('../cli');

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'freeze-'));
  const state = path.join(dir, 'state.json');
  const cli = (args) => run([...args, '--state', state], { cwd: dir, env: {} });
  const cliJson = (args) => {
    const result = cli(args);
    assert.equal(result.code, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  return { dir, state, cli, cliJson };
}

test('CLI: load, hold, query, release, undo round-trip', () => {
  const { dir, cliJson } = setup();
  fs.writeFileSync(path.join(dir, 'graph.json'), JSON.stringify({ edges: [['M', 'A'], ['M', 'B'], ['C', 'M']] }));

  assert.deepEqual(cliJson(['load', 'graph.json']), { ok: true, lots: 4, edges: 3 });
  cliJson(['hold', '--id', 'sup-a', '--lot', 'A', '--type', 'supplier', '--severity', '3']);
  cliJson(['hold', '--id', 'cust-c', '--lot', 'C', '--type', 'customer', '--severity', '5']);

  const merged = cliJson(['query', '--lot', 'M']);
  assert.deepEqual(merged, { lot: 'M', frozen: true, severity: 5, reasons: ['cust-c', 'sup-a'] });

  cliJson(['release', '--id', 'sup-a']);
  assert.deepEqual(cliJson(['query', '--lot', 'M']).reasons, ['cust-c']);
  assert.equal(cliJson(['query', '--lot', 'M']).severity, 5);

  cliJson(['undo']);
  assert.deepEqual(cliJson(['query', '--lot', 'M']).reasons, ['cust-c', 'sup-a']);
});

test('CLI: null severity via --severity null keeps hold effective', () => {
  const { dir, cliJson } = setup();
  fs.writeFileSync(path.join(dir, 'graph.json'), JSON.stringify({ edges: [['D', 'S']] }));
  cliJson(['load', 'graph.json']);
  cliJson(['hold', '--id', 'h1', '--lot', 'S', '--type', 'supplier', '--severity', 'null']);
  assert.deepEqual(cliJson(['query', '--lot', 'D']), { lot: 'D', frozen: true, severity: null, reasons: ['h1'] });
});

test('CLI: cyclic graph is rejected and leaves no state behind', () => {
  const { dir, state, cli } = setup();
  fs.writeFileSync(path.join(dir, 'cycle.json'), JSON.stringify({ edges: [['A', 'B'], ['B', 'A']] }));

  const rejected = cli(['load', 'cycle.json']);
  assert.equal(rejected.code, 1);
  assert.match(rejected.stderr, /cycle/);
  assert.equal(fs.existsSync(state), false);

  // A follow-up transaction cannot proceed: no partial results were committed.
  const next = cli(['hold', '--id', 'x', '--lot', 'A', '--type', 'supplier']);
  assert.equal(next.code, 1);
  assert.match(next.stderr, /no state/);
});

test('CLI: merge flag applies split/merge edges as an incremental transaction', () => {
  const { dir, cliJson } = setup();
  fs.writeFileSync(path.join(dir, 'base.json'), JSON.stringify({ edges: [['M', 'A']] }));
  fs.writeFileSync(path.join(dir, 'merge.json'), JSON.stringify({ merge: true, edges: [['M', 'B']] }));
  cliJson(['load', 'base.json']);
  cliJson(['hold', '--id', 'sup-b', '--lot', 'B', '--type', 'supplier', '--severity', '2']);
  assert.deepEqual(cliJson(['query', '--lot', 'M']).reasons, []);

  cliJson(['load', 'merge.json']);
  assert.deepEqual(cliJson(['query', '--lot', 'M']).reasons, ['sup-b']);
});
