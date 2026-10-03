'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const CLI = path.join(__dirname, '..', 'cli.js');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'settle-cli-'));
}

// Runs the CLI as a real child process. Output is captured through temp
// files (via /bin/sh redirection) rather than inherited pipes, which is
// robust in restricted sandbox environments.
function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

function run(args) {
  const io = tmpDir();
  const outFile = path.join(io, 'out');
  const errFile = path.join(io, 'err');
  const codeFile = path.join(io, 'code');
  const cmd = [process.execPath, CLI, ...args].map(shellQuote).join(' ');
  spawnSync('/bin/sh', ['-c', `${cmd} >${shellQuote(outFile)} 2>${shellQuote(errFile)}; printf %s $? >${shellQuote(codeFile)}`]);
  const code = Number(fs.readFileSync(codeFile, 'utf8'));
  const stdout = fs.readFileSync(outFile, 'utf8');
  return { code, stdout, json: JSON.parse(stdout.trim()) };
}

function runAsync(args) {
  const io = tmpDir();
  const outFile = path.join(io, 'out');
  const errFile = path.join(io, 'err');
  const codeFile = path.join(io, 'code');
  const cmd = [process.execPath, CLI, ...args].map(shellQuote).join(' ');
  return new Promise((resolve, reject) => {
    const child = spawn('/bin/sh', ['-c', `${cmd} >${shellQuote(outFile)} 2>${shellQuote(errFile)}; printf %s $? >${shellQuote(codeFile)}`]);
    child.on('error', reject);
    child.on('close', () => {
      const code = Number(fs.readFileSync(codeFile, 'utf8'));
      const stdout = fs.readFileSync(outFile, 'utf8');
      resolve({ code, stdout, json: JSON.parse(stdout.trim()) });
    });
  });
}

test('CLI: settle via tx, cancel via tx, then get --at exports history', () => {
  const dir = tmpDir();

  const settle = run([
    '--dir', dir, 'tx',
    JSON.stringify({
      gets: ['account:m1'],
      puts: {
        'settle:s1': { id: 's1', merchant: 'm1', amount: 100, status: 'OPEN' },
        'account:m1': { balance: 100 },
        'account:clearing': { balance: -100 },
      },
    }),
  ]);
  assert.equal(settle.code, 0);
  assert.deepEqual(settle.json, { version: 1 });

  const cancel = run(['--dir', dir, 'tx', JSON.stringify({ cancel: 's1' })]);
  assert.equal(cancel.code, 0);
  assert.deepEqual(cancel.json, { version: 2 });

  const atV1 = run(['--dir', dir, 'get', 'settle:s1', '--at', '1']);
  assert.equal(atV1.code, 0);
  assert.equal(atV1.json.value.status, 'OPEN');

  const atV2 = run(['--dir', dir, 'get', 'settle:s1', '--at', '2']);
  assert.equal(atV2.json.value.status, 'CANCELLED');

  const acct = run(['--dir', dir, 'get', 'account:m1', '--at', '2']);
  assert.equal(acct.json.value.balance, 0);

  const reversal = run(['--dir', dir, 'get', 'reversal:s1', '--at', '2']);
  assert.deepEqual(reversal.json.value.entries, [
    { account: 'm1', side: 'debit', amount: 100 },
    { account: 'clearing', side: 'credit', amount: 100 },
  ]);

  // Dump of full state at a historical version.
  const dump = run(['--dir', dir, 'get', '--at', '1']);
  assert.equal(dump.json.version, 1);
  assert.equal(dump.json.state['settle:s1'].status, 'OPEN');
  assert.equal(dump.json.state['reversal:s1'], undefined);
});

test('CLI: failures print {"error":CODE} and exit non-zero', () => {
  const dir = tmpDir();

  const missing = run(['--dir', dir, 'tx', JSON.stringify({ cancel: 'ghost' })]);
  assert.notEqual(missing.code, 0);
  assert.deepEqual(missing.json, { error: 'E_NOT_FOUND' });

  run(['--dir', dir, 'tx', JSON.stringify({ puts: { 'settle:s1': { id: 's1', merchant: 'm1', amount: 5, status: 'OPEN' } } })]);
  run(['--dir', dir, 'tx', JSON.stringify({ cancel: 's1' })]);

  const twice = run(['--dir', dir, 'tx', JSON.stringify({ cancel: 's1' })]);
  assert.notEqual(twice.code, 0);
  assert.deepEqual(twice.json, { error: 'E_INVALID_STATE' });

  const badJson = run(['--dir', dir, 'tx', '{not json']);
  assert.notEqual(badJson.code, 0);
  assert.deepEqual(badJson.json, { error: 'E_BAD_REQUEST' });

  const noKey = run(['--dir', dir, 'get', 'missing:key']);
  assert.notEqual(noKey.code, 0);
  assert.deepEqual(noKey.json, { error: 'E_NOT_FOUND' });
});

test('CLI: two concurrent processes cancelling the same OPEN slip - exactly one succeeds', async () => {
  const dir = tmpDir();
  const setup = run([
    '--dir', dir, 'tx',
    JSON.stringify({
      puts: {
        'settle:s1': { id: 's1', merchant: 'm1', amount: 100, status: 'OPEN' },
        'account:m1': { balance: 100 },
        'account:clearing': { balance: -100 },
      },
    }),
  ]);
  assert.equal(setup.code, 0);

  const [r1, r2] = await Promise.all([
    runAsync(['--dir', dir, 'tx', JSON.stringify({ cancel: 's1' })]),
    runAsync(['--dir', dir, 'tx', JSON.stringify({ cancel: 's1' })]),
  ]);

  const results = [r1, r2];
  const ok = results.filter((r) => r.code === 0);
  const failed = results.filter((r) => r.code !== 0);
  assert.equal(ok.length, 1, `exactly one winner: ${JSON.stringify(results)}`);
  assert.equal(failed.length, 1);
  assert.ok(
    failed[0].json.error === 'E_CONFLICT' || failed[0].json.error === 'E_INVALID_STATE',
    `loser must fail with E_CONFLICT or E_INVALID_STATE, got ${JSON.stringify(failed[0])}`
  );
  assert.equal(typeof ok[0].json.version, 'number');

  const head = run(['--dir', dir, 'get', 'settle:s1']);
  assert.equal(head.json.value.status, 'CANCELLED');
  const acct = run(['--dir', dir, 'get', 'account:m1']);
  assert.equal(acct.json.value.balance, 0);
});
