'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runCli } = require('../src/cli');

function run(input, args = []) {
  return runCli(args, () => input);
}

function lines(res) {
  return res.stdout.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

const SCRIPT = [
  JSON.stringify({ op: 'calendar', version: 'v1', holidays: [] }),
  JSON.stringify({ op: 'trade', id: 'T1', payCcy: 'EUR', payAmt: 100, recvCcy: 'USD', recvAmt: 110, valueDate: '2026-01-05' }),
  JSON.stringify({ op: 'trade', id: 'T2', payCcy: 'USD', payAmt: 110, recvCcy: 'EUR', recvAmt: 100, valueDate: '2026-01-05' }),
  JSON.stringify({ op: 'liquidity', ccy: 'EUR', amount: 100 }),
  JSON.stringify({ op: 'liquidity', ccy: 'USD', amount: 50 }),
  JSON.stringify({ op: 'deliverables' }),
  JSON.stringify({ op: 'exposures' }),
  JSON.stringify({ op: 'proof' }),
].join('\n') + '\n';

test('CLI processes JSONL and emits deliverables, exposures and proof', () => {
  const res = run(SCRIPT);
  assert.equal(res.code, 0, res.stderr);
  const out = lines(res);
  const deliv = out.find((o) => o.type === 'deliverables');
  const t1 = deliv.items.find((i) => i.tradeId === 'T1');
  const t2 = deliv.items.find((i) => i.tradeId === 'T2');
  assert.equal(t1.status, 'DELIVERABLE');
  assert.equal(t2.status, 'PENDING');
  assert.equal(t2.reason, 'INSUFFICIENT_LIQUIDITY:USD');
  const exp = out.find((o) => o.type === 'exposures');
  assert.deepEqual(exp.items, []);
  const proof = out.find((o) => o.type === 'proof');
  assert.equal(proof.replay, 'PROOF_OK');
  assert.equal(proof.events, 5);
});

test('CLI exits 7 with stderr on invalid JSON', () => {
  const res = run('this is not json\n');
  assert.equal(res.code, 7);
  assert.match(res.stderr, /invalid JSON/);
});

test('CLI exits 7 on unknown op and on engine errors', () => {
  assert.equal(run(JSON.stringify({ op: 'bogus' }) + '\n').code, 7);
  const res = run(JSON.stringify({ op: 'cancel', id: 'NOPE' }) + '\n');
  assert.equal(res.code, 7);
  assert.match(res.stderr, /unknown trade/);
});

test('CLI persists via --data and reloads across runs', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vd-cli-'));
  const first = run(SCRIPT, ['--data', dir]);
  assert.equal(first.code, 0, first.stderr);
  assert.deepEqual(lines(first)[0], { type: 'loaded', events: 0, indexRebuilt: false });

  const second = run(JSON.stringify({ op: 'proof' }) + '\n', ['--data', dir]);
  assert.equal(second.code, 0, second.stderr);
  const out = lines(second);
  assert.deepEqual(out[0], { type: 'loaded', events: 5, indexRebuilt: false });
  assert.equal(out[1].replay, 'PROOF_OK');
  assert.equal(out[1].events, 5);

  fs.writeFileSync(path.join(dir, 'index.json'), '{"journalSeq":5,"que');
  const third = run(JSON.stringify({ op: 'deliverables' }) + '\n', ['--data', dir]);
  assert.equal(third.code, 0, third.stderr);
  const out3 = lines(third);
  assert.equal(out3[0].indexRebuilt, true);
  assert.equal(out3[1].items.length, 2);
});
