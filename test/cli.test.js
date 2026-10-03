'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { runRequest } = require('../src/engine');
const { execute } = require('../src/cli');

const CLI = path.join(__dirname, '..', 'src', 'cli.js');

const REQ = {
  state: {
    nodes: [
      { id: 'raw', kind: 'source', value: 2 },
      { id: 'raw2', kind: 'source', value: 3 },
      { id: 'doubled', kind: 'derived', op: 'sum', inputs: ['raw', 'raw2'] },
      { id: 'stats', kind: 'derived', op: 'avg', inputs: ['doubled'] },
    ],
  },
  transactions: [
    { id: 'fix', undoTag: 'calib', ops: [{ type: 'setSource', node: 'raw', value: 10 }] },
    { id: 'bad', ops: [{ type: 'addEdge', from: 'stats', to: 'doubled' }] },
    { id: 'revert', ops: [{ type: 'undo', undoTag: 'calib' }] },
  ],
};

test('cli execute matches the engine and reports cycle/undo correctly', () => {
  const { code, output } = execute(JSON.stringify(REQ));
  assert.equal(code, 0);
  const res = JSON.parse(output);
  assert.deepEqual(res, runRequest(REQ));
  assert.equal(res.ok, true);
  assert.equal(res.results.length, 3);
  assert.equal(res.results[1].error.code, 'E_CYCLE');
  assert.equal(res.results[2].ok, true); // undo succeeds
  const raw = res.final.state.nodes.find((n) => n.id === 'raw');
  assert.equal(raw.value, 2); // calibration undone
});

test('cli reports E_PARSE on invalid JSON with non-zero exit code', () => {
  const { code, output } = execute('{ not json');
  assert.equal(code, 1);
  const res = JSON.parse(output);
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'E_PARSE');
});

test('cli handles empty transactions', () => {
  const { code, output } = execute(JSON.stringify({ state: { nodes: [] }, transactions: [] }));
  assert.equal(code, 0);
  const res = JSON.parse(output);
  assert.equal(res.ok, true);
  assert.deepEqual(res.results, []);
  assert.equal(res.final.version, 0);
});

test('cli works as a real subprocess: node src/cli.js < req.json > res.json', (t) => {
  // Sandboxed environments may forbid spawning; verify through the shell.
  require('node:fs').writeFileSync('/tmp/cli-req.json', JSON.stringify(REQ));
  let out;
  try {
    out = execFileSync(
      '/bin/sh',
      ['-c', `${process.execPath} ${CLI} < /tmp/cli-req.json`],
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
    );
  } catch (e) {
    t.skip(`subprocess spawn not permitted here: ${e.message}`);
    return;
  }
  assert.deepEqual(JSON.parse(out), runRequest(REQ));
});
