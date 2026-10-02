import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { initStore, openStore, commit, undo, redo, verify } from '../src/log.js';
import { stateHash } from '../src/state.js';

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sched-log-'));
}

const machine = { id: 'M1', calendar: [[0, 100]] };
const order1 = {
  id: 'W1',
  priority: 2,
  ops: [{ id: 'a', machine: 'M1', duration: 5, family: 'A', preds: [] }],
};

function indexEntries(dir) {
  return fs
    .readFileSync(path.join(dir, 'snapshot.index'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

function flipByteInLine(dir, lineIndex) {
  const logPath = path.join(dir, 'log.dat');
  const buf = fs.readFileSync(logPath);
  let start = 0;
  for (let i = 0; i < lineIndex; i++) start = buf.indexOf(0x0a, start) + 1;
  buf[start + 2] = buf[start + 2] === 0x61 ? 0x62 : 0x61;
  fs.writeFileSync(logPath, buf);
}

test('3 commits, 2 undos, 1 redo: state, snapshot hash and audit chain consistent', () => {
  const a = tmp();
  initStore(a, { snapshotEvery: 2 });
  commit(a, [{ type: 'addMachine', machine }]);
  commit(a, [{ type: 'addOrder', order: order1 }]);
  commit(a, [{ type: 'setSetup', machine: 'M1', from: 'A', to: 'B', time: 7 }]);
  undo(a);
  undo(a);
  redo(a);

  const b = tmp();
  initStore(b, { snapshotEvery: 2 });
  commit(b, [{ type: 'addMachine', machine }]);
  commit(b, [{ type: 'addOrder', order: order1 }]);

  const sa = openStore(a);
  const sb = openStore(b);
  assert.equal(stateHash(sa.state), stateHash(sb.state));
  assert.deepEqual(sa.records.map((r) => r.type), [
    'change',
    'change',
    'change',
    'undo',
    'undo',
    'redo',
  ]);
  // Snapshot at seq 2 identical in both stores.
  const s2a = indexEntries(a).find((e) => e.seq === 2);
  const s2b = indexEntries(b).find((e) => e.seq === 2);
  assert.deepEqual(s2a, s2b);
  // Audit chain: shared prefix hashes identical, full chain verifies.
  assert.equal(sa.records[0].hash, sb.records[0].hash);
  assert.equal(sa.records[1].hash, sb.records[1].hash);
  assert.equal(verify(a).ok, true);
  assert.equal(verify(b).ok, true);
  // Undo appended compensating records; history was not erased.
  assert.equal(sa.records.length, 6);
  assert.equal(sa.records[3].target, 3);
  assert.equal(sa.records[4].target, 2);
  assert.equal(sa.records[5].target, 2);
});

test('undo/redo state transitions', () => {
  const d = tmp();
  initStore(d, { snapshotEvery: 2 });
  commit(d, [{ type: 'addMachine', machine }]);
  commit(d, [{ type: 'addOrder', order: order1 }]);
  const afterC2 = stateHash(openStore(d).state);
  commit(d, [{ type: 'setSetup', machine: 'M1', from: 'A', to: 'B', time: 7 }]);
  undo(d);
  assert.equal(stateHash(openStore(d).state), afterC2);
  redo(d);
  assert.equal(openStore(d).state.setup.M1.A.B, 7);
});

test('redo rejected after history diverges', () => {
  const d = tmp();
  initStore(d);
  commit(d, [{ type: 'addMachine', machine }]);
  commit(d, [{ type: 'addOrder', order: order1 }]);
  undo(d);
  commit(d, [{ type: 'setSetup', machine: 'M1', from: 'A', to: 'B', time: 3 }]);
  assert.throws(() => redo(d), { code: 'E_DIVERGED' });
  assert.throws(() => redo(d), { code: 'E_DIVERGED' });
});

test('corrupt tail chunk: last transaction invisible, snapshot still opens', () => {
  const d = tmp();
  initStore(d, { snapshotEvery: 2 });
  commit(d, [{ type: 'addMachine', machine }]);
  commit(d, [{ type: 'addOrder', order: order1 }]);
  commit(d, [{ type: 'setSetup', machine: 'M1', from: 'A', to: 'B', time: 7 }]);
  const before = stateHash(openStore(d).state);
  commit(d, [{ type: 'setSetup', machine: 'M1', from: 'B', to: 'C', time: 9 }]);
  assert.equal(openStore(d).state.setup.M1.B.C, 9);

  flipByteInLine(d, 3); // corrupt the 4th (current tail) chunk

  const s = openStore(d);
  assert.equal(s.seq, 3);
  assert.equal(stateHash(s.state), before);
  assert.equal(s.state.setup.M1.B?.C, undefined);
  // Snapshot at seq 2 still loads and anchors recovery.
  const entries = indexEntries(d);
  assert.equal(entries[entries.length - 1].seq, 2);
  assert.equal(verify(d).ok, true);
  // Log remains appendable after recovery.
  commit(d, [{ type: 'setSetup', machine: 'M1', from: 'C', to: 'D', time: 1 }]);
  assert.equal(openStore(d).state.setup.M1.C.D, 1);
});

test('corrupt non-tail chunk: E_CRC', () => {
  const d = tmp();
  initStore(d, { snapshotEvery: 2 });
  commit(d, [{ type: 'addMachine', machine }]);
  commit(d, [{ type: 'addOrder', order: order1 }]);
  commit(d, [{ type: 'setSetup', machine: 'M1', from: 'A', to: 'B', time: 7 }]);
  flipByteInLine(d, 0); // corrupt a historical chunk
  assert.throws(() => openStore(d), { code: 'E_CRC' });
});

test('tampered record hash breaks audit chain with E_CRC', async () => {
  const d = tmp();
  initStore(d);
  commit(d, [{ type: 'addMachine', machine }]);
  commit(d, [{ type: 'addOrder', order: order1 }]);
  // Rewrite first chunk with valid CRC but altered content.
  const logPath = path.join(d, 'log.dat');
  const lines = fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean);
  const payload = JSON.parse(Buffer.from(lines[0].slice(9), 'base64').toString('utf8'));
  payload.ops[0].machine.calendar = [[0, 50]];
  const { crc32 } = await import('../src/crc32.js');
  const { canonical } = await import('../src/canon.js');
  const buf = Buffer.from(canonical(payload), 'utf8');
  lines[0] = crc32(buf).toString(16).padStart(8, '0') + ' ' + buf.toString('base64');
  fs.writeFileSync(logPath, lines.join('\n') + '\n');
  assert.throws(() => openStore(d), { code: 'E_CRC' });
});
