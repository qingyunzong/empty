import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run } from '../cli.js';

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cli-'));

// Invoke the CLI in-process (the sandboxed test environment cannot spawn
// child processes with pipes). Each call reopens the store from --data-dir,
// so cross-invocation persistence is exercised exactly as with separate
// processes.
async function cli(dir, ...args) {
  let stdout = '';
  let stderr = '';
  const code = await run(['--data-dir', dir, ...args], {
    out: (s) => (stdout += s),
    err: (s) => (stderr += s),
  });
  return { code, out: stdout ? JSON.parse(stdout) : null, err: stderr };
}

test('CLI end-to-end: create, debit, balance, usage, history, error codes', async () => {
  const dir = tmpdir();

  let r = await cli(dir, 'create-account', 'alice', '100');
  assert.equal(r.code, 0);
  assert.equal(r.out.ok, true);

  r = await cli(dir, 'debit', 'alice', '30', 'gpu-hour');
  assert.equal(r.code, 0);
  assert.equal(r.out.balance, 70);

  r = await cli(dir, 'balance', 'alice');
  assert.deepEqual(r.out, { account: 'alice', balance: 70 });

  r = await cli(dir, 'usage', 'alice');
  assert.equal(r.out.length, 1);
  assert.equal(r.out[0].amount, 30);
  assert.equal(r.out[0].note, 'gpu-hour');

  r = await cli(dir, 'history');
  assert.equal(r.out.length, 2);

  r = await cli(dir, 'debit', 'alice', '1000');
  assert.equal(r.code, 4);
  assert.match(r.err, /ERROR BUDGET_EXCEEDED/);

  r = await cli(dir, 'balance', 'ghost');
  assert.equal(r.code, 2);
  assert.match(r.err, /ERROR NO_ACCOUNT/);

  // State persists across CLI invocations (each reopens the store).
  r = await cli(dir, 'balance', 'alice');
  assert.equal(r.out.balance, 70);
});
