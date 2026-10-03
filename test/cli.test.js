import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runCli } from '../src/cli.js';

function makeWorkspace(graph) {
  const dir = mkdtempSync(path.join(tmpdir(), 'freeze-cli-'));
  const graphPath = path.join(dir, 'graph.json');
  writeFileSync(graphPath, JSON.stringify(graph));
  return { dir, graphPath, statePath: path.join(dir, 'state.json') };
}

function invoke(workspace, args) {
  const out = [];
  const err = [];
  const status = runCli(['--state', workspace.statePath, ...args], {
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
  });
  return { status, stdout: out.join('\n'), stderr: err.join('\n') };
}

function invokeOk(workspace, args) {
  const result = invoke(workspace, args);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

const mergeGraph = {
  lots: ['A', 'B', 'M', 'P'],
  edges: [
    { child: 'M', parent: 'A' },
    { child: 'M', parent: 'B' },
    { child: 'P', parent: 'M' },
  ],
};

test('cli: load, hold, query, release, undo end to end', () => {
  const workspace = makeWorkspace(mergeGraph);
  const loaded = invokeOk(workspace, ['load', workspace.graphPath]);
  assert.equal(loaded.loaded, true);
  assert.equal(loaded.lots, 4);

  invokeOk(workspace, ['hold', 'h-sup', 'A', 'supplier', '3']);
  invokeOk(workspace, ['hold', 'h-cus', 'P', 'customer', 'null']);

  let query = invokeOk(workspace, ['query', 'M']);
  assert.deepEqual(query, { lot: 'M', frozen: true, severity: null, reasons: ['h-cus', 'h-sup'] });

  query = invokeOk(workspace, ['query', 'B']);
  assert.deepEqual(query.reasons, ['h-cus']);

  invokeOk(workspace, ['release', 'h-cus']);
  query = invokeOk(workspace, ['query', 'M']);
  assert.deepEqual(query, { lot: 'M', frozen: true, severity: 3, reasons: ['h-sup'] });
  assert.equal(invokeOk(workspace, ['query', 'B']).frozen, false);

  const undone = invokeOk(workspace, ['undo']);
  assert.deepEqual(undone, { undone: 'release', hold: 'h-cus' });
  query = invokeOk(workspace, ['query', 'M']);
  assert.deepEqual(query.reasons, ['h-cus', 'h-sup']);
  assert.equal(query.severity, null);
});

test('cli: cyclic graph is rejected and leaves no state behind', () => {
  const workspace = makeWorkspace({
    lots: ['A', 'B'],
    edges: [
      { child: 'A', parent: 'B' },
      { child: 'B', parent: 'A' },
    ],
  });
  const result = invoke(workspace, ['load', workspace.graphPath]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /cycle/);
  assert.equal(existsSync(workspace.statePath), false);

  const query = invoke(workspace, ['query', 'A']);
  assert.equal(query.status, 1);
  assert.match(query.stderr, /no state found/);
});

test('cli: failed hold does not modify persisted state', () => {
  const workspace = makeWorkspace(mergeGraph);
  invokeOk(workspace, ['load', workspace.graphPath]);
  invokeOk(workspace, ['hold', 'h1', 'A', 'supplier', '2']);
  const bad = invoke(workspace, ['hold', 'h2', 'NOPE', 'supplier', '1']);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /unknown lot/);
  const query = invokeOk(workspace, ['query', 'A']);
  assert.deepEqual(query.reasons, ['h1']);
});

test('cli: usage errors are reported with exit code 1', () => {
  const workspace = makeWorkspace(mergeGraph);
  assert.equal(invoke(workspace, []).status, 1);
  assert.equal(invoke(workspace, ['bogus']).status, 1);
  assert.equal(invoke(workspace, ['load']).status, 1);
  invokeOk(workspace, ['load', workspace.graphPath]);
  assert.equal(invoke(workspace, ['hold', 'h1', 'A', 'supplier', 'abc']).status, 1);
});
