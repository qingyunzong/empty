'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { tmpLedgerDir } = require('./helpers');

const CLI = path.join(__dirname, '..', 'cli.js');

// Note: child stdout/stderr are captured via temp files because pipe capture
// is unreliable in some sandboxed environments.
function run(dir, args) {
  return new Promise((resolve, reject) => {
    const outFile = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-out-')) + '/out';
    const errFile = outFile + '.err';
    const outFd = fs.openSync(outFile, 'w');
    const errFd = fs.openSync(errFile, 'w');
    const child = spawn(process.execPath, [CLI, '--dir', dir, ...args], {
      stdio: ['ignore', outFd, errFd],
    });
    child.on('error', reject);
    child.on('close', (code) => {
      fs.closeSync(outFd);
      fs.closeSync(errFd);
      const stdout = fs.readFileSync(outFile, 'utf8');
      const stderr = fs.readFileSync(errFile, 'utf8');
      resolve({ code, stdout, stderr, json: stdout ? tryParse(stdout) : null });
    });
  });
}

function tryParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

test('full lifecycle exits 0 and verify passes', async () => {
  const dir = tmpLedgerDir();
  assert.equal((await run(dir, ['freeze', 'A', '100'])).code, 0);
  assert.equal((await run(dir, ['enqueue', 'p1', 'A', '30'])).code, 0);
  assert.equal((await run(dir, ['enqueue', 'p2', 'A', '30'])).code, 0);
  // Idempotent re-enqueue exits 0.
  const dup = await run(dir, ['enqueue', 'p1', 'A', '30']);
  assert.equal(dup.code, 0);
  assert.equal(dup.json.idempotent, true);

  const settle = await run(dir, ['settle']);
  assert.equal(settle.code, 0);
  assert.deepEqual(settle.json.selected, ['p1', 'p2']);

  const verify = await run(dir, ['verify']);
  assert.equal(verify.code, 0);
  assert.equal(verify.json.ok, true);

  // Settled payment cannot be cancelled -> exit 1.
  assert.equal((await run(dir, ['cancel', 'p1'])).code, 1);
  // Refund restores budget -> exit 0, reverse block references original hash.
  const refund = await run(dir, ['refund', 'p1']);
  assert.equal(refund.code, 0);
  assert.equal(refund.json.body.ref, settle.json.hash);
  assert.equal(refund.json.account.budget, 70); // 100 - 30(p1) - 30(p2) + 30(refund p1)
  assert.equal((await run(dir, ['verify'])).code, 0);

  const batch = await run(dir, ['batch', '1']);
  assert.equal(batch.code, 0);
  assert.equal(batch.json.type, 'settle');
  assert.equal((await run(dir, ['batch'])).code, 0);
});

test('cancel of a queued payment releases the freeze (exit 0)', async () => {
  const dir = tmpLedgerDir();
  await run(dir, ['freeze', 'A', '100']);
  await run(dir, ['enqueue', 'p1', 'A', '40']);
  const r = await run(dir, ['cancel', 'p1']);
  assert.equal(r.code, 0);
  assert.equal(r.json.account.available, 100);
});

test('business failures exit 1', async () => {
  const dir = tmpLedgerDir();
  await run(dir, ['freeze', 'A', '50']);
  assert.equal((await run(dir, ['enqueue', 'p1', 'A', '60'])).code, 1); // over budget
  assert.equal((await run(dir, ['enqueue', 'p1', 'ghost', '10'])).code, 1); // unknown account
  assert.equal((await run(dir, ['cancel', 'ghost'])).code, 1); // unknown payment
  assert.equal((await run(dir, ['settle'])).code, 1); // empty queue
  assert.equal((await run(dir, ['batch', '9'])).code, 1); // no such batch
});

test('usage errors exit 2', async () => {
  const dir = tmpLedgerDir();
  assert.equal((await run(dir, [])).code, 2);
  assert.equal((await run(dir, ['frobnicate'])).code, 2);
  assert.equal((await run(dir, ['enqueue', 'p1', 'A'])).code, 2);
  assert.equal((await run(dir, ['enqueue', 'p1', 'A', 'abc'])).code, 2);
  assert.equal((await run(dir, ['freeze', 'A'])).code, 2);
});

test('recover exits 0 when admitting orphans, 1 on CRC failure', async () => {
  const dir = tmpLedgerDir();
  await run(dir, ['freeze', 'A', '1000']);
  await run(dir, ['enqueue', 'p1', 'A', '100']);
  await run(dir, ['settle']);
  await run(dir, ['enqueue', 'p2', 'A', '200']);

  // Simulate the crash: roll index/state back to just before the next settle.
  const stateSnapshot = fs.readFileSync(path.join(dir, 'state.json'), 'utf8');
  const indexSnapshot = fs.readFileSync(path.join(dir, 'index.json'), 'utf8');
  await run(dir, ['settle']);
  fs.writeFileSync(path.join(dir, 'state.json'), stateSnapshot);
  fs.writeFileSync(path.join(dir, 'index.json'), indexSnapshot);

  // Verify fails while the orphan is unconfirmed.
  assert.equal((await run(dir, ['verify'])).code, 1);
  // Recover admits it.
  const ok = await run(dir, ['recover']);
  assert.equal(ok.code, 0);
  assert.deepEqual(ok.json.admitted.map((a) => a.batch), [2]);
  assert.equal((await run(dir, ['verify'])).code, 0);

  // Corrupt the next orphan and confirm recover exits 1.
  await run(dir, ['enqueue', 'p3', 'A', '300']);
  const state2 = fs.readFileSync(path.join(dir, 'state.json'), 'utf8');
  const index2 = fs.readFileSync(path.join(dir, 'index.json'), 'utf8');
  await run(dir, ['settle']);
  fs.writeFileSync(path.join(dir, 'state.json'), state2);
  fs.writeFileSync(path.join(dir, 'index.json'), index2);
  const block3 = path.join(dir, 'blocks', '000003.blk');
  const text = fs.readFileSync(block3, 'utf8');
  fs.writeFileSync(block3, text.replace('"amount":300', '"amount":301'));

  const bad = await run(dir, ['recover']);
  assert.equal(bad.code, 1);
  assert.equal(bad.json.failed.batch, 3);
  assert.equal(bad.json.confirmed, 2);
});
