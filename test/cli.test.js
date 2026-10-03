import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runCli } from '../src/cli.js';
import { makeTempDir } from '../support/helpers.js';

test('cli init/query/undo/status happy path and error exit codes', () => {
  const dir = makeTempDir();
  const nodesFile = path.join(dir, 'nodes-input.json');
  fs.writeFileSync(
    nodesFile,
    JSON.stringify([
      { id: 'a', parentId: null, amount: 10, reason: 'pay refund now', state: 'active' },
      { id: 'b', parentId: 'a', amount: 20, reason: 'pay refund later', state: 'active' },
    ]),
  );
  const stateDir = path.join(dir, 'state');

  const init = runCli(['init', '--dir', stateDir, '--nodes', nodesFile]);
  assert.equal(init.code, 0, init.stderr);
  assert.equal(JSON.parse(init.stdout).ok, true);

  const query = runCli(['query', '--dir', stateDir, '--root', 'a', '--phrase', 'pay refund', '--slop', '0']);
  assert.equal(query.code, 0, query.stderr);
  assert.deepEqual(
    JSON.parse(query.stdout).hits.map((h) => h.nodeId),
    ['a', 'b'],
  );

  const undoRes = runCli(['undo', '--dir', stateDir, '--root', 'a', '--phrase', 'pay refund', '--budget', '100']);
  assert.equal(undoRes.code, 0, undoRes.stderr);
  const undoOut = JSON.parse(undoRes.stdout);
  assert.equal(undoOut.ok, true);
  assert.equal(undoOut.batchId, 'BATCH-000001');
  assert.equal(undoOut.certificate.totalAmount, 30);

  const status = runCli(['status', '--dir', stateDir]);
  assert.equal(status.code, 0, status.stderr);
  const statusOut = JSON.parse(status.stdout);
  assert.deepEqual(statusOut.nodes.map((n) => n.state), ['undone', 'undone']);
  assert.deepEqual(statusOut.batches, ['BATCH-000001']);

  const dup = runCli(['undo', '--dir', stateDir, '--root', 'a', '--phrase', 'pay refund', '--budget', '100']);
  assert.equal(dup.code, 1);
  assert.equal(JSON.parse(dup.stderr).error.code, 'ALREADY_UNDONE');

  const missing = runCli(['undo', '--dir', stateDir, '--root', 'ghost', '--phrase', 'pay refund', '--budget', '100']);
  assert.equal(missing.code, 1);
  assert.equal(JSON.parse(missing.stderr).error.code, 'ROOT_NOT_FOUND');

  const lowBudget = runCli(['undo', '--dir', stateDir, '--root', 'a', '--phrase', 'pay refund', '--budget', '1']);
  assert.equal(lowBudget.code, 1);
  assert.equal(JSON.parse(lowBudget.stderr).error.code, 'ALREADY_UNDONE');

  const noCommand = runCli(['bogus']);
  assert.equal(noCommand.code, 2);
});
