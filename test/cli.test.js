'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { run } = require('../cli');
const { eventHash } = require('../lib/machine');

let dir;
before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reversal-cli-'));
});
after(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function makeIo() {
  const io = { out: '', err: '' };
  return {
    io,
    captured: {
      stdout: (c) => { io.out += c; },
      stderr: (c) => { io.err += c; },
    },
  };
}

function writeEvents(name, events) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return p;
}

const t1 = { type: 'tx', eventId: 'e1', logicalClock: 1, txId: 't1', amount: 100 };
const txHash = eventHash(t1);
const r1 = { type: 'reversal', eventId: 'e2', logicalClock: 2, txHash, amount: 100 };
const revHash = eventHash(r1);
const i1 = { type: 'reinstate', eventId: 'e3', logicalClock: 3, reversalHash: revHash, amount: 100 };

test('cli apply emits JSONL certs and writes verifiable state', () => {
  const eventsPath = writeEvents('ok.jsonl', [i1, t1, r1]); // out of order on purpose
  const statePath = path.join(dir, 'state.json');

  const apply = makeIo();
  const applyCode = run(['apply', eventsPath, statePath], apply.captured);
  assert.equal(applyCode, 0);
  assert.equal(apply.io.err, '');

  const lines = apply.io.out.trim().split('\n');
  assert.equal(lines.length, 3);
  const certs = lines.map((l) => JSON.parse(l));
  assert.equal(certs[0].seq, 0);
  assert.equal(certs[1].prevHash, certs[0].certHash);
  assert.equal(certs[2].prevHash, certs[1].certHash);

  const verify = makeIo();
  const verifyCode = run(['verify', statePath], verify.captured);
  assert.equal(verifyCode, 0);
  const result = JSON.parse(verify.io.out.trim());
  assert.equal(result.ok, true);
  assert.equal(result.certsChecked, 3);
  assert.equal(result.final.balance, 100);
});

test('cli apply exits 1 with E_AMOUNT on stderr for over-reversal', () => {
  const bad = { type: 'reversal', eventId: 'e9', logicalClock: 2, txHash, amount: 101 };
  const eventsPath = writeEvents('over.jsonl', [t1, bad]);
  const { io, captured } = makeIo();
  const code = run(['apply', eventsPath, path.join(dir, 'x.json')], captured);
  assert.equal(code, 1);
  assert.match(io.err, /^E_AMOUNT:/);
  assert.equal(io.out, '');
});

test('cli verify exits 1 with E_CERT for forged prevHash', () => {
  const eventsPath = writeEvents('forge.jsonl', [t1, r1]);
  const statePath = path.join(dir, 'forge-state.json');
  assert.equal(run(['apply', eventsPath, statePath], makeIo().captured), 0);

  const snap = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  snap.certs[1].prevHash = 'f'.repeat(64);
  fs.writeFileSync(statePath, JSON.stringify(snap));

  const { io, captured } = makeIo();
  const code = run(['verify', statePath], captured);
  assert.equal(code, 1);
  assert.match(io.err, /^E_CERT:/);
});

test('cli verify exits 1 with E_CERT for tampered event log', () => {
  const eventsPath = writeEvents('tamper.jsonl', [t1, r1]);
  const statePath = path.join(dir, 'tamper-state.json');
  assert.equal(run(['apply', eventsPath, statePath], makeIo().captured), 0);

  const snap = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  snap.events[1].amount = 1;
  fs.writeFileSync(statePath, JSON.stringify(snap));

  const { io, captured } = makeIo();
  const code = run(['verify', statePath], captured);
  assert.equal(code, 1);
  assert.match(io.err, /^E_CERT:/);
});

test('cli usage error exits 1', () => {
  const { io, captured } = makeIo();
  assert.equal(run([], captured), 1);
  assert.match(io.err, /usage:/);
});
