import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.js');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-test-'));
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

// Runs the CLI in a child process. Output is captured via file redirection
// because pipe capture is unreliable in this sandboxed environment.
function run(args, dir) {
  const io = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-io-'));
  const outFile = path.join(io, 'out');
  const errFile = path.join(io, 'err');
  const codeFile = path.join(io, 'code');
  const cmd =
    [process.execPath, CLI, ...args, '--dir', dir].map(shellQuote).join(' ') +
    ` >${shellQuote(outFile)} 2>${shellQuote(errFile)}; echo $? >${shellQuote(codeFile)}`;
  spawnSync('sh', ['-c', cmd], { encoding: 'utf8' });
  return {
    status: Number(fs.readFileSync(codeFile, 'utf8').trim()),
    stdout: fs.readFileSync(outFile, 'utf8'),
    stderr: fs.readFileSync(errFile, 'utf8'),
  };
}

function stdoutJson(res) {
  return JSON.parse(res.stdout.trim());
}

function stderrJson(res) {
  return JSON.parse(res.stderr.trim());
}

// Independent WAL parser used only by tests: enumerates valid frames and
// sums amounts of transactions that have a matching COMMIT record.
function independentCommittedSum(walPath, merchant) {
  const buf = fs.readFileSync(walPath);
  let offset = 0;
  let sum = 0;
  const pending = new Map();
  while (offset + 13 <= buf.length) {
    const length = buf.readUInt32LE(offset);
    const seq = buf.readUInt32LE(offset + 4);
    const type = buf.readUInt8(offset + 8);
    const end = offset + 9 + length + 4;
    if (end > buf.length) break; // truncated frame: discard the rest
    const body = buf.subarray(offset, offset + 9 + length);
    const expected = buf.readUInt32LE(offset + 9 + length);
    if (crc32Ref(body) !== expected) break; // CRC error: discard the rest
    const payload = JSON.parse(buf.subarray(offset + 9, offset + 9 + length).toString('utf8'));
    if (type === 1) {
      pending.set(seq, payload);
    } else if (type === 2) {
      const txn = pending.get(payload.txSeq);
      if (txn && txn.merchant === merchant) sum += txn.amount;
      pending.delete(payload.txSeq);
    }
    offset = end;
  }
  return sum;
}

function crc32Ref(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}

test('pay, cancel and duplicate cancel returns E_ALREADY_CANCELLED', () => {
  const dir = tmpDir();

  const pay = run(['pay', '--id', 't1', '--merchant', 'M1', '--amount', '500'], dir);
  assert.equal(pay.status, 0, pay.stderr);
  assert.equal(stdoutJson(pay).ok, true);

  const cancel = run(['cancel', '--id', 't1'], dir);
  assert.equal(cancel.status, 0, cancel.stderr);
  assert.equal(stdoutJson(cancel).transaction.amount, -500);

  const again = run(['cancel', '--id', 't1'], dir);
  assert.notEqual(again.status, 0);
  const err = stderrJson(again);
  assert.equal(err.error.code, 'E_ALREADY_CANCELLED');

  const audit = stdoutJson(run(['audit', '--merchant', 'M1'], dir));
  assert.equal(audit.balance, 0);
  assert.equal(audit.transactions.length, 2);
});

test('errors are JSON objects on stderr with non-zero exit code', () => {
  const dir = tmpDir();
  const res = run(['cancel', '--id', 'missing'], dir);
  assert.notEqual(res.status, 0);
  const err = stderrJson(res);
  assert.equal(typeof err.error, 'object');
  assert.equal(err.error.code, 'E_TXN_NOT_FOUND');

  const bad = run(['pay', '--id', 't1', '--merchant', 'M1', '--amount', '-5'], dir);
  assert.notEqual(bad.status, 0);
  assert.equal(stderrJson(bad).error.code, 'E_INVALID_AMOUNT');
});

test('crash at P1 leaves no transaction and no balance change after recovery', () => {
  const dir = tmpDir();
  const crash = run(['crash', '--point', 'P1', '--id', 't1', '--merchant', 'M1', '--amount', '700'], dir);
  assert.notEqual(crash.status, 0);

  const recovery = stdoutJson(run(['recover'], dir));
  assert.equal(recovery.ok, true);

  const audit = stdoutJson(run(['audit', '--merchant', 'M1'], dir));
  assert.equal(audit.balance, 0);
  assert.equal(audit.transactions.length, 0);
});

test('crash at P2 keeps the transaction effective and auditable after recovery', () => {
  const dir = tmpDir();
  const crash = run(['crash', '--point', 'P2', '--id', 't1', '--merchant', 'M1', '--amount', '700'], dir);
  assert.notEqual(crash.status, 0);

  const recovery = stdoutJson(run(['recover'], dir));
  assert.equal(recovery.ok, true);

  const audit = stdoutJson(run(['audit', '--merchant', 'M1'], dir));
  assert.equal(audit.balance, 700);
  assert.equal(audit.transactions.length, 1);
  assert.equal(audit.transactions[0].id, 't1');
});

test('truncated last frame with corrupted CRC is discarded; recovery matches independent sum', () => {
  const dir = tmpDir();
  for (const [id, amount] of [['t1', 100], ['t2', 250], ['t3', 75]]) {
    const res = run(['pay', '--id', id, '--merchant', 'M1', '--amount', String(amount)], dir);
    assert.equal(res.status, 0, res.stderr);
  }
  const other = run(['pay', '--id', 'x1', '--merchant', 'M2', '--amount', '40'], dir);
  assert.equal(other.status, 0, other.stderr);

  const walPath = path.join(dir, 'wal.log');
  const original = fs.readFileSync(walPath);

  // Locate the last frame, corrupt its CRC, then truncate it mid-frame.
  let lastFrameOffset = 0;
  {
    let offset = 0;
    while (offset + 13 <= original.length) {
      const length = original.readUInt32LE(offset);
      const end = offset + 9 + length + 4;
      if (end > original.length) break;
      lastFrameOffset = offset;
      offset = end;
    }
  }
  const corrupted = Buffer.from(original);
  const lastLength = corrupted.readUInt32LE(lastFrameOffset);
  const crcOffset = lastFrameOffset + 9 + lastLength;
  corrupted[crcOffset] ^= 0xff; // corrupt the CRC of the last frame
  fs.writeFileSync(walPath, corrupted.subarray(0, corrupted.length - 3)); // truncate tail

  const recovery = stdoutJson(run(['recover'], dir));
  assert.equal(recovery.ok, true);
  assert.ok(recovery.discardedBytes > 0);
  assert.ok(['E_CRC_MISMATCH', 'E_TRUNCATED_FRAME'].includes(recovery.corruption.code));

  const expected = independentCommittedSum(walPath, 'M1');
  const audit = stdoutJson(run(['audit', '--merchant', 'M1'], dir));
  assert.equal(audit.balance, expected);
  assert.equal(recovery.balances.M1, expected);

  const expectedM2 = independentCommittedSum(walPath, 'M2');
  assert.equal(stdoutJson(run(['audit', '--merchant', 'M2'], dir)).balance, expectedM2);
});

test('merchant secondary index is rebuilt from WAL across restarts', () => {
  const dir = tmpDir();
  run(['pay', '--id', 'a1', '--merchant', 'MA', '--amount', '10'], dir);
  run(['pay', '--id', 'b1', '--merchant', 'MB', '--amount', '20'], dir);
  run(['pay', '--id', 'a2', '--merchant', 'MA', '--amount', '30'], dir);
  run(['cancel', '--id', 'a1'], dir);

  const auditA = stdoutJson(run(['audit', '--merchant', 'MA'], dir));
  assert.equal(auditA.balance, 30);
  assert.deepEqual(auditA.transactions.map((t) => t.id), ['a1', 'a2', 'cancel:a1']);

  const auditB = stdoutJson(run(['audit', '--merchant', 'MB'], dir));
  assert.equal(auditB.balance, 20);
  assert.equal(auditB.transactions.length, 1);
});
