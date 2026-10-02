import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import { initialState, applyOp } from '../src/state.js';
import { BusinessError, CorruptError } from '../src/errors.js';
import { HEADER_LEN } from '../src/block.js';
import { runCli } from '../cli.js';

const TOTAL = 1000;

// 10 ticket operations: freeze x3, batched captures, releases, one undo.
const OPS = [
  { type: 'freeze', amount: 100 }, // op1  -> T1
  { type: 'freeze', amount: 200 }, // op2  -> T2
  { type: 'capture', ticketId: 'T1', amount: 40 }, // op3
  { type: 'capture', ticketId: 'T2', amount: 50 }, // op4
  { type: 'release', ticketId: 'T1' }, // op5
  { type: 'freeze', amount: 150 }, // op6  -> T3
  { type: 'capture', ticketId: 'T3', amount: 30 }, // op7
  { type: 'undo', opId: 'op7' }, // op8  (reverse delta)
  { type: 'capture', ticketId: 'T2', amount: 100 }, // op9
  { type: 'release', ticketId: 'T2' }, // op10
];

function makeDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-'));
}

function makeStore(dir) {
  return new Store(path.join(dir, 'ledger.bin'));
}

// Invokes the CLI in-process (the sandbox forbids child processes) and
// captures exit code plus stdout/stderr exactly as a shell caller would see.
function cli(args) {
  const res = { stdout: '', stderr: '' };
  res.status = runCli(args, {
    stdout: (s) => { res.stdout += s; },
    stderr: (s) => { res.stderr += s; },
  });
  return res;
}

// Naive reference: replay the full op array from scratch up to version v.
function referenceState(v) {
  const state = initialState(TOTAL);
  for (let i = 0; i < v; i++) applyOp(state, OPS[i]);
  return state;
}

function buildLedger(dir) {
  const store = makeStore(dir);
  store.init(TOTAL);
  for (const op of OPS) store.appendOp(op);
  return store;
}

test('10 ticket ops: every version matches naive full-array replay', () => {
  const dir = makeDir();
  const store = buildLedger(dir);

  for (let v = 0; v <= OPS.length; v++) {
    assert.deepStrictEqual(store.restore(v), referenceState(v), `state at version ${v}`);
  }

  const cert = JSON.parse(fs.readFileSync(path.join(dir, 'ledger.bin.cert'), 'utf8'));
  assert.equal(cert.version, OPS.length);
  assert.equal(store.verify().version, OPS.length);
});

test('duplicate release, over-capture and undo of unknown op are rejected', () => {
  const dir = makeDir();
  const store = makeStore(dir);
  store.init(500);
  store.appendOp({ type: 'freeze', amount: 100 }); // T1
  store.appendOp({ type: 'release', ticketId: 'T1' });

  assert.throws(() => store.appendOp({ type: 'release', ticketId: 'T1' }), BusinessError);

  store.appendOp({ type: 'freeze', amount: 50 }); // T2
  assert.throws(() => store.appendOp({ type: 'capture', ticketId: 'T2', amount: 51 }), BusinessError);

  assert.throws(() => store.appendOp({ type: 'undo', opId: 'op999' }), BusinessError);

  // CLI rejects with exit code 1 as well.
  const file = path.join(dir, 'ledger.bin');
  const res = cli(['release', '--ticket', 'T1', '--file', file]);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /REJECTED/);
});

test('corrupted middle delta: older versions recover, newer fail with CORRUPT', () => {
  const dir = makeDir();
  const file = path.join(dir, 'ledger.bin');
  const store = makeStore(dir);
  buildLedger(dir);

  // Flip one payload byte inside the delta block of version 7.
  const badVersion = 7;
  const index = JSON.parse(fs.readFileSync(`${file}.idx`, 'utf8'));
  const offset = index.versions[String(badVersion)];
  const fd = fs.openSync(file, 'r+');
  const byte = Buffer.alloc(1);
  fs.readSync(fd, byte, 0, 1, offset + HEADER_LEN);
  byte[0] ^= 0xff;
  fs.writeSync(fd, byte, 0, 1, offset + HEADER_LEN);
  fs.closeSync(fd);

  // Versions earlier than the bad block still recover exactly.
  for (const v of [0, 3, 5, 6]) {
    assert.deepStrictEqual(store.restore(v), referenceState(v), `state at version ${v}`);
  }

  // The bad version and every later version fail, never half-merged state.
  for (const v of [7, 8, 9, 10]) {
    assert.throws(() => store.restore(v), CorruptError, `version ${v} must be CORRUPT`);
  }

  // CLI: old version exits 0, new version exits 2 with code=CORRUPT and no state on stdout.
  const okRes = cli(['restore', '--version', '6', '--file', file]);
  assert.equal(okRes.status, 0);
  assert.deepStrictEqual(JSON.parse(okRes.stdout), referenceState(6));

  const badRes = cli(['restore', '--version', '8', '--file', file]);
  assert.equal(badRes.status, 2);
  assert.match(badRes.stderr, /CORRUPT/);
  assert.equal(badRes.stdout.trim(), '');

  const verifyRes = cli(['verify', '--file', file]);
  assert.equal(verifyRes.status, 2);
  assert.match(verifyRes.stderr, /CORRUPT/);
});
