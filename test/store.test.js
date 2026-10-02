import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Journal } from '../src/store.js';
import { Lab } from '../src/lab.js';

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'calib-journal-'));
}

const p1 = { id: 'p1', dut: 'D', time: '2026-06-01', range: 'R1', envClass: 'E1', budget: null, envWindow: null };
const p2 = { id: 'p2', dut: 'D', time: '2026-06-02', range: 'R1', envClass: 'E1', budget: null, envWindow: null };

test('committed measures survive reopen', () => {
  const dir = tmpdir();
  const j1 = new Journal(dir);
  j1.append(p1);
  j1.append(p2);
  const j2 = new Journal(dir);
  assert.deepEqual(j2.records, [p1, p2]);
});

test('crash after append but before rename: torn tail is invisible', () => {
  const dir = tmpdir();
  const j1 = new Journal(dir);
  j1.append(p1);
  // simulate crash: partial line appended, no fsync, no HEAD update
  fs.appendFileSync(path.join(dir, 'measures.log'), JSON.stringify(p2).slice(0, 20));
  const j2 = new Journal(dir);
  assert.deepEqual(j2.records, [p1]);
  // journal stays usable after recovery
  j2.append(p2);
  const j3 = new Journal(dir);
  assert.deepEqual(j3.records, [p1, p2]);
});

test('crash with full line but no HEAD commit: record is invisible', () => {
  const dir = tmpdir();
  const j1 = new Journal(dir);
  j1.append(p1);
  fs.appendFileSync(path.join(dir, 'measures.log'), JSON.stringify(p2) + '\n');
  const j2 = new Journal(dir);
  assert.deepEqual(j2.records, [p1]);
});

test('leftover HEAD.tmp from crash before rename is ignored', () => {
  const dir = tmpdir();
  const j1 = new Journal(dir);
  j1.append(p1);
  fs.writeFileSync(path.join(dir, 'HEAD.tmp'), JSON.stringify({ offset: 9999, hash: 'deadbeef' }));
  const j2 = new Journal(dir);
  assert.deepEqual(j2.records, [p1]);
});

test('corrupt committed line: recovery keeps verified prefix, no half measure', () => {
  const dir = tmpdir();
  const j1 = new Journal(dir);
  j1.append(p1);
  j1.append(p2);
  // corrupt the second line in place (same length, keep newline structure)
  const logPath = path.join(dir, 'measures.log');
  const buf = fs.readFileSync(logPath);
  const firstNl = buf.indexOf(0x0a);
  buf[firstNl + 5] = 0x21; // '!' inside second record
  fs.writeFileSync(logPath, buf);
  const j2 = new Journal(dir);
  assert.deepEqual(j2.records, [p1]);
  assert.ok(j2.records.every((r) => typeof r.id === 'string'));
});

test('Lab recovers measurement points from the journal on restart', () => {
  const dir = tmpdir();
  const lab1 = new Lab({ store: new Journal(dir) });
  lab1.addArtifact({ id: 'D', kind: 'dut', range: 'R1', grade: 'G3', envClass: 'E1', u: 0.05, validFrom: '2026-01-01', validTo: '2026-12-31' });
  lab1.measure({ id: 'p1', dut: 'D', time: '2026-06-01', range: 'R1', envClass: 'E1' });
  const lab2 = new Lab({ store: new Journal(dir) });
  assert.ok(lab2.points.has('p1'));
  const r = lab2.certify('p1');
  assert.equal(r.status, 'INSUFFICIENT_EVIDENCE'); // env window missing, but point recovered
});
