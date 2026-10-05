import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../cli.js';
import { tempDir } from './helpers.js';

function cli(dir, args) {
  return run(['--dir', dir, ...args]);
}

test('cli receive/balance/duplicate/error exit codes', () => {
  const dir = tempDir();

  const recv = cli(dir, ['receive', '--batch', 'A', '--qty', '10', '--key', 'c1']);
  assert.equal(recv.code, 0);
  const recvJson = JSON.parse(recv.stdout);
  assert.deepEqual(recvJson, { ok: true, op: 'receive', batch: 'A', onHand: 10 });

  const dup = cli(dir, ['receive', '--batch', 'A', '--qty', '10', '--key', 'c1']);
  assert.equal(dup.code, 0);
  assert.deepEqual(JSON.parse(dup.stdout), recvJson);

  const balance = cli(dir, ['balance']);
  assert.equal(balance.code, 0);
  assert.equal(JSON.parse(balance.stdout).batches.A.onHand, 10);

  const over = cli(dir, ['reserve', '--batch', 'A', '--qty', '99', '--key', 'c2']);
  assert.equal(over.code, 2);
  assert.equal(JSON.parse(over.stdout).code, 'E_STOCK');

  const rollback = cli(dir, ['rollback', '--name', 'missing']);
  assert.equal(rollback.code, 3);
  assert.equal(JSON.parse(rollback.stderr).code, 'E_SAVEPOINT');

  const savepoint = cli(dir, ['savepoint', '--name', 'S']);
  assert.equal(savepoint.code, 0);
  const issue = cli(dir, ['issue', '--batch', 'A', '--qty', '4', '--key', 'c3']);
  assert.equal(issue.code, 0);
  const back = cli(dir, ['rollback', '--name', 'S']);
  assert.equal(back.code, 0);
  const cert = JSON.parse(back.stdout);
  assert.equal(cert.savepoint, 'S');
  assert.deepEqual(cert.reversedKeys, ['c3']);
  assert.equal(JSON.parse(cli(dir, ['balance']).stdout).batches.A.onHand, 10);
});
