import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Engine, CrashFault } from '../src/engine.js';
import { Wal } from '../src/wal.js';

const FRAMES = [
  { type: 'payment', order: 'o1', amount: 2000, seq: 1, ts: 0 },
  { type: 'refund', key: 'k1', order: 'o1', amount: 300, riskTag: 'high', seq: 2, ts: 10 },
  { type: 'refund', key: 'k2', order: 'o1', amount: 200, riskTag: 'low', seq: 3, ts: 20 },
  { type: 'approve', key: 'k1', seq: 4, ts: 30 },
  { type: 'reject', key: 'k2', seq: 5, ts: 40 },
  { type: 'reverse', key: 'k1', seq: 6, ts: 50 },
];

function cleanReport() {
  const engine = new Engine(Wal.open(null));
  for (const f of FRAMES) engine.process(f);
  return engine.report();
}

function runWithCrash(crashSeq, point, walPath) {
  let crashed = false;
  const hooks = {
    [point]: (frame) => {
      if (!crashed && frame.seq === crashSeq) {
        crashed = true;
        throw new CrashFault(`crash at ${point} for seq ${crashSeq}`);
      }
    },
  };
  const engine1 = new Engine(Wal.open(walPath), hooks);
  try {
    for (const f of FRAMES) engine1.process(f);
    assert.fail('expected crash');
  } catch (err) {
    assert.ok(err instanceof CrashFault);
  }
  const engine2 = new Engine(Wal.open(walPath, { replay: true }));
  const idx = FRAMES.findIndex((f) => f.seq === crashSeq);
  for (const f of FRAMES.slice(idx)) engine2.process(f);
  return engine2.report();
}

for (const point of ['beforeDecision', 'afterLog', 'beforeResponse']) {
  for (const crashSeq of [2, 4, 6]) {
    test(`recovery: crash ${point} at seq ${crashSeq} replays without double effects`, () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'refund-wal-'));
      const walPath = path.join(dir, 'wal.log');
      const report = runWithCrash(crashSeq, point, walPath);
      const expected = cleanReport();
      assert.deepEqual(report, expected);
      assert.equal(report.budget.used, 0);
      assert.equal(report.orders.o1.refunded, 0);
      assert.equal(report.orders.o1.refundable, 2000);
      assert.ok(fs.readFileSync(walPath, 'utf8').trim().split('\n').length > 0);
    });
  }
}

test('recovery: wal audit hash survives restart and equals clean run', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'refund-wal-'));
  const walPath = path.join(dir, 'wal.log');
  const engine1 = new Engine(Wal.open(walPath));
  for (const f of FRAMES.slice(0, 3)) engine1.process(f);
  const engine2 = new Engine(Wal.open(walPath, { replay: true }));
  for (const f of FRAMES.slice(3)) engine2.process(f);
  assert.equal(engine2.report().auditHash, cleanReport().auditHash);
});
