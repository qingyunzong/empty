import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runPlan } from '../testlib/cli.js';

const SCRIPT_A = `
  line L1, L2;
  calendar main { shift mon..fri 08:00-16:00; }
  constraint overlap(L1) <= 1 and overlap(L2) <= 1;
  job J1 { line: L1; duration: 2h; priority: 2; }
  add-job J2 { line: L2; duration: 1h; priority: 1; };
  commit;
`;

const SCRIPT_B = `
  add-job J3 { line: L1; duration: 3h; priority: 3; after: J1; };
  savepoint sp;
  move-job J2 to L1;
  rollback sp;
  commit;
`;

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-rec-'));
  assert.equal(runPlan(['init', dir]).code, 0);
  const a = path.join(dir, 'a.plan');
  const b = path.join(dir, 'b.plan');
  fs.writeFileSync(a, SCRIPT_A);
  fs.writeFileSync(b, SCRIPT_B);
  assert.equal(runPlan(['apply', dir, a]).code, 0);
  const afterA = runPlan(['export', dir]);
  assert.equal(afterA.code, 0);
  assert.equal(runPlan(['apply', dir, b]).code, 0);
  const afterB = runPlan(['export', dir]);
  assert.equal(afterB.code, 0);
  return { dir, baseline1: afterA.stdout, baseline2: afterB.stdout };
}

function exportOf(dir) {
  const r = runPlan(['export', dir]);
  assert.equal(r.code, 0, r.stderr);
  return r.stdout;
}

const WAL = path.join('wal', '000001.log');
const STATE = path.join('state', 'state.json');
const CKPT = path.join('checkpoint', 'checkpoint.json');

test('fault point 1: crash before WAL commit leaves an ignored tail (acceptance 3)', () => {
  const { dir, baseline2 } = setup();
  // Simulate a torn write of a third, uncommitted transaction.
  fs.appendFileSync(path.join(dir, WAL), '{"seq":3,"script":"add-job J9 { line: L1; dura');
  const rec = runPlan(['recover', dir]);
  assert.equal(rec.code, 0, rec.stderr);
  assert.match(rec.stdout, /RECOVERED seq=2/);
  assert.match(rec.stdout, /tail=ignored/);
  assert.equal(exportOf(dir), baseline2, 'recovered state equals last commit');
});

test('fault point 2: crash after WAL commit, before state write (acceptance 3)', () => {
  const { dir, baseline2 } = setup();
  fs.unlinkSync(path.join(dir, STATE));
  const rec = runPlan(['recover', dir]);
  assert.equal(rec.code, 0, rec.stderr);
  assert.match(rec.stdout, /RECOVERED seq=2/);
  assert.match(rec.stdout, /repaired=state/);
  assert.equal(exportOf(dir), baseline2, 'state rebuilt idempotently from WAL');
});

test('fault point 3: crash after state write, before checkpoint (acceptance 3)', () => {
  const { dir, baseline2 } = setup();
  fs.unlinkSync(path.join(dir, CKPT));
  const rec = runPlan(['recover', dir]);
  assert.equal(rec.code, 0, rec.stderr);
  assert.match(rec.stdout, /RECOVERED seq=2/);
  assert.match(rec.stdout, /repaired=checkpoint/);
  assert.equal(exportOf(dir), baseline2, 'checkpoint rebuilt, state untouched');
});

test('stale state from an older commit is repaired to the last commit', () => {
  const { dir, baseline1, baseline2 } = setup();
  // Rewind state to seq=1 by hand: re-run recovery against a WAL truncated
  // to its first record, keep the resulting state, then restore the WAL.
  const walPath = path.join(dir, WAL);
  const fullWal = fs.readFileSync(walPath, 'utf8');
  const firstLine = fullWal.split('\n')[0] + '\n';
  fs.writeFileSync(walPath, firstLine);
  assert.equal(runPlan(['recover', dir]).code, 0);
  assert.equal(exportOf(dir), baseline1);
  fs.writeFileSync(walPath, fullWal);
  const rec = runPlan(['recover', dir]);
  assert.equal(rec.code, 0);
  assert.match(rec.stdout, /repaired=state/);
  assert.equal(exportOf(dir), baseline2);
});

function flipByte(file, offset) {
  const buf = fs.readFileSync(file);
  buf[offset] = buf[offset] === 65 ? 66 : 65;
  fs.writeFileSync(file, buf);
}

test('checksum corruption in the middle of the WAL is a RECOVERY_ERROR (acceptance 5)', () => {
  const { dir } = setup();
  const walPath = path.join(dir, WAL);
  const firstLen = fs.readFileSync(walPath, 'utf8').split('\n')[0].length;
  flipByte(walPath, Math.floor(firstLen / 2));
  const rec = runPlan(['recover', dir]);
  assert.equal(rec.code, 3);
  assert.match(rec.stderr, /RECOVERY_ERROR/);
  // export must fail the same way rather than silently recovering
  const exp = runPlan(['export', dir]);
  assert.equal(exp.code, 3);
  assert.match(exp.stderr, /RECOVERY_ERROR/);
});

test('checksum failure in the WAL tail is ignored as uncommitted (acceptance 5)', () => {
  const { dir, baseline1 } = setup();
  const walPath = path.join(dir, WAL);
  const data = fs.readFileSync(walPath);
  flipByte(walPath, data.length - 10); // inside the last (second) record
  const rec = runPlan(['recover', dir]);
  assert.equal(rec.code, 0, rec.stderr);
  assert.match(rec.stdout, /tail=ignored/);
  // The corrupted committed record is dropped; state equals the first commit.
  assert.equal(exportOf(dir), baseline1);
});

test('corrupt state checksum is repaired from the WAL (acceptance 5)', () => {
  const { dir, baseline2 } = setup();
  flipByte(path.join(dir, STATE), 20);
  const rec = runPlan(['recover', dir]);
  assert.equal(rec.code, 0, rec.stderr);
  assert.match(rec.stdout, /repaired=state/);
  assert.equal(exportOf(dir), baseline2);
});

test('corrupt checkpoint checksum is rebuilt (acceptance 5)', () => {
  const { dir, baseline2 } = setup();
  flipByte(path.join(dir, CKPT), 20);
  const rec = runPlan(['recover', dir]);
  assert.equal(rec.code, 0, rec.stderr);
  assert.match(rec.stdout, /repaired=checkpoint/);
  assert.equal(exportOf(dir), baseline2);
});

test('clean recovery reports repaired=none', () => {
  const { dir } = setup();
  const rec = runPlan(['recover', dir]);
  assert.equal(rec.code, 0);
  assert.match(rec.stdout, /RECOVERED seq=2 repaired=none/);
});
