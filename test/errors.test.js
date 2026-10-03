import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Store } from '../src/store.js';
import { EvidenceError } from '../src/errors.js';
import { tmpdir } from './helpers.js';

function assertCode(fn, code) {
  assert.throws(fn, (err) => err instanceof EvidenceError && err.code === code);
}

test('E_CYCLE: direct self-reference and indirect cycle are rejected', () => {
  const s = Store.open(tmpdir());
  s.append('ADD_FACT', { id: 'f', source: 's' });
  assertCode(() => s.append('ADD_DERIVED', { id: 'x', op: 'count', inputs: ['x'] }), 'E_CYCLE');

  s.append('ADD_DERIVED', { id: 'a', op: 'count', inputs: ['f'] });
  s.append('ADD_DERIVED', { id: 'b', op: 'count', inputs: ['a'] });
  // redefining a to depend on b would close a -> b -> a
  assertCode(() => s.append('ADD_DERIVED', { id: 'a', op: 'count', inputs: ['b'] }), 'E_CYCLE');
  // the failed derive must not corrupt state
  assert.equal(s.status('b').status, 'valid');
});

test('E_SOURCE_GONE: revoke/restore of unknown source', () => {
  const s = Store.open(tmpdir());
  assertCode(() => s.append('REVOKE_SOURCE', { id: 'ghost' }), 'E_SOURCE_GONE');
  assertCode(() => s.append('RESTORE_SOURCE', { id: 'ghost' }), 'E_SOURCE_GONE');
});

test('E_WAL: corrupt line in the middle of the log', () => {
  const dir = tmpdir();
  const s = Store.open(dir);
  s.append('ADD_FACT', { id: 'f1', source: 's1' });
  s.append('ADD_FACT', { id: 'f2', source: 's1' });
  const wal = path.join(dir, 'wal.log');
  const lines = fs.readFileSync(wal, 'utf8').split('\n');
  lines[0] = '{"seq":1,"broken"';
  fs.writeFileSync(wal, lines.join('\n'));
  assertCode(() => Store.open(dir), 'E_WAL');
});

test('E_WAL: index checkpoint ahead of WAL', () => {
  const dir = tmpdir();
  const s = Store.open(dir);
  s.append('ADD_FACT', { id: 'f1', source: 's1' });
  fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify({ appliedSeq: 99, appliedHash: 'x' }));
  assertCode(() => Store.open(dir), 'E_WAL');
});

test('E_HASH: tampered event hash, prev link, and snapshot checksum', () => {
  // tampered event payload -> hash mismatch
  {
    const dir = tmpdir();
    const s = Store.open(dir);
    s.append('ADD_FACT', { id: 'f1', source: 's1' });
    s.append('ADD_FACT', { id: 'f2', source: 's1' });
    const wal = path.join(dir, 'wal.log');
    const lines = fs.readFileSync(wal, 'utf8').trim().split('\n');
    const ev = JSON.parse(lines[0]);
    ev.payload.value = 999; // tamper
    lines[0] = JSON.stringify(ev);
    fs.writeFileSync(wal, `${lines.join('\n')}\n`);
    assertCode(() => Store.open(dir), 'E_HASH');
  }
  // tampered prev link
  {
    const dir = tmpdir();
    const s = Store.open(dir);
    s.append('ADD_FACT', { id: 'f1', source: 's1' });
    s.append('ADD_FACT', { id: 'f2', source: 's1' });
    const wal = path.join(dir, 'wal.log');
    const lines = fs.readFileSync(wal, 'utf8').trim().split('\n');
    const ev = JSON.parse(lines[1]);
    ev.prev = 'deadbeef'.repeat(8);
    lines[1] = JSON.stringify(ev);
    fs.writeFileSync(wal, `${lines.join('\n')}\n`);
    assertCode(() => Store.open(dir), 'E_HASH');
  }
  // tampered snapshot
  {
    const dir = tmpdir();
    const s = Store.open(dir);
    s.append('ADD_FACT', { id: 'f1', source: 's1' });
    s.snapshot();
    const snapPath = path.join(dir, 'snapshot.json');
    const snap = JSON.parse(fs.readFileSync(snapPath, 'utf8'));
    snap.state.facts.f1.value = 999; // tamper
    fs.writeFileSync(snapPath, JSON.stringify(snap));
    assertCode(() => Store.open(dir), 'E_HASH');
  }
});

test('verifylog is strict: torn tail reported as E_WAL, not repaired', () => {
  const dir = tmpdir();
  const s = Store.open(dir);
  s.append('ADD_FACT', { id: 'f1', source: 's1' });
  fs.appendFileSync(path.join(dir, 'wal.log'), '{"seq":2,"typ');
  assertCode(() => s.verify(), 'E_WAL');
});
