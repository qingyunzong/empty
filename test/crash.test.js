import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { QmsStore } from '../src/store.js';
import { CorruptionError } from '../src/errors.js';
import { tmpDir, crashAt, SimulatedCrash, referenceReplay } from './helpers.js';

const NOW = '2026-10-03T00:00:00.000Z';
const openOpts = { now: () => NOW };

function initDir() {
  const dir = tmpDir();
  QmsStore.init(dir);
  return dir;
}

test('crash after data sync: uncommitted record produces no judgment on recovery', () => {
  const dir = initDir();
  const store = QmsStore.open(dir, openOpts);
  store.report({ clientRecordId: 'c-1', lotId: 'LOT-A', testCode: 'dimension.length', value: 10.0 });

  const crashing = QmsStore.open(dir, { ...openOpts, crashHook: crashAt('dataSync') });
  assert.throws(
    () => crashing.report({ clientRecordId: 'c-2', lotId: 'LOT-A', testCode: 'dimension.length', value: 10.5 }),
    (err) => err instanceof SimulatedCrash && err.point === 'dataSync'
  );

  const recovered = QmsStore.open(dir, openOpts);
  assert.equal(recovered.state.seq, 1);
  assert.equal(Object.keys(recovered.state.records).length, 1);
  const status = recovered.status('LOT-A', 'dimension.length');
  assert.equal(status.judgment, 'OK');
  assert.equal(status.recordId, 'rec-00000001');

  const walLines = fs.readFileSync(path.join(dir, 'wal.log'), 'utf8').trim().split('\n');
  assert.equal(walLines.length, 2, 'uncommitted tail must be truncated during recovery');

  const again = recovered.report({ clientRecordId: 'c-2', lotId: 'LOT-A', testCode: 'dimension.length', value: 10.5 });
  assert.equal(again.duplicate, false);
  assert.equal(again.recordId, 'rec-00000002');
  assert.equal(again.judgment, 'NG');

  assert.deepEqual(QmsStore.open(dir, openOpts).snapshot(), referenceReplay(dir));
});

test('crash after commit marker sync: committed record survives recovery', () => {
  const dir = initDir();
  const store = QmsStore.open(dir, openOpts);
  store.report({ clientRecordId: 'c-1', lotId: 'LOT-A', testCode: 'dimension.length', value: 10.0 });

  const crashing = QmsStore.open(dir, { ...openOpts, crashHook: crashAt('commitSync') });
  assert.throws(
    () => crashing.report({ clientRecordId: 'c-2', lotId: 'LOT-A', testCode: 'dimension.length', value: 10.5 }),
    (err) => err instanceof SimulatedCrash && err.point === 'commitSync'
  );

  const recovered = QmsStore.open(dir, openOpts);
  assert.equal(recovered.state.seq, 2);
  const status = recovered.status('LOT-A', 'dimension.length');
  assert.equal(status.judgment, 'NG');
  assert.equal(status.recordId, 'rec-00000002');
  assert.equal(recovered.verify().checked, 2);

  const dup = recovered.report({ clientRecordId: 'c-2', lotId: 'LOT-A', testCode: 'dimension.length', value: 10.5 });
  assert.equal(dup.duplicate, true);

  assert.deepEqual(QmsStore.open(dir, openOpts).snapshot(), referenceReplay(dir));
});

test('interleaved crashes at both fault points converge to reference replay', () => {
  const dir = initDir();
  const script = [
    { op: 'report', payload: { clientRecordId: 'c-1', lotId: 'LOT-A', testCode: 'dimension.length', value: 10.0 } },
    { op: 'report', payload: { clientRecordId: 'c-2', lotId: 'LOT-A', testCode: 'dimension.length', value: 10.5 }, crash: 'dataSync' },
    { op: 'report', payload: { clientRecordId: 'c-2', lotId: 'LOT-A', testCode: 'dimension.length', value: 10.5 } },
    { op: 'report', payload: { clientRecordId: 'c-3', lotId: 'LOT-B', testCode: 'electrical.voltage', value: 3.3 }, crash: 'commitSync' },
    { op: 'report', payload: { clientRecordId: 'c-3', lotId: 'LOT-B', testCode: 'electrical.voltage', value: 3.3 } },
    { op: 'correct', payload: { clientRecordId: 'c-4', correctsRecordId: 'rec-00000002', value: 10.6 }, crash: 'dataSync' },
    { op: 'correct', payload: { clientRecordId: 'c-4', correctsRecordId: 'rec-00000002', value: 10.6 } },
    { op: 'report', payload: { clientRecordId: 'c-5', lotId: 'LOT-B', testCode: 'electrical.voltage', value: 9.9 } }
  ];
  for (const step of script) {
    const hook = step.crash ? crashAt(step.crash) : null;
    const store = QmsStore.open(dir, { ...openOpts, crashHook: hook });
    try {
      store[step.op](step.payload);
    } catch (err) {
      if (!(err instanceof SimulatedCrash)) throw err;
    }
  }
  const recovered = QmsStore.open(dir, openOpts);
  assert.deepEqual(recovered.snapshot(), referenceReplay(dir));
  assert.equal(recovered.status('LOT-A', 'dimension.length').judgment, 'NCR');
  assert.equal(recovered.status('LOT-B', 'electrical.voltage').judgment, 'NG');
  assert.equal(recovered.verify().ok, true);
});

test('corrupted WAL is detected as corruption, not silently ignored', () => {
  const dir = initDir();
  const store = QmsStore.open(dir, openOpts);
  store.report({ clientRecordId: 'c-1', lotId: 'LOT-A', testCode: 'dimension.length', value: 10.0 });
  fs.appendFileSync(path.join(dir, 'wal.log'), '{"kind":"data","seq":2,"recordId":"rec-00000002","prevHash":"deadbeef","hash":"bad","record":{"clientRecordId":"c-2","lotId":"LOT-A","testCode":"dimension.length","value":10.0,"type":"measurement"},"judgment":"OK"}\n{"kind":"commit","seq":2,"hash":"bad"}\n');
  assert.throws(() => QmsStore.open(dir, openOpts), (err) => err instanceof CorruptionError);
});

test('torn trailing write is detected as corruption', () => {
  const dir = initDir();
  const store = QmsStore.open(dir, openOpts);
  store.report({ clientRecordId: 'c-1', lotId: 'LOT-A', testCode: 'dimension.length', value: 10.0 });
  fs.appendFileSync(path.join(dir, 'wal.log'), '{"kind":"data","seq":2,"rec');
  assert.throws(() => QmsStore.open(dir, openOpts), (err) => err instanceof CorruptionError);
});
