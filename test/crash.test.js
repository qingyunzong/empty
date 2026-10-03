import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import { buildCert } from '../src/cert.js';
import { canonical } from '../src/canon.js';

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lg-crash-'));
  const s = Store.init(dir, { site: 'F' });
  s.add({ op: 'register', out: [{ lot: 'A', mass: 100 }] });
  s.add({ op: 'register', out: [{ lot: 'B', mass: 50 }] });
  s.add({ op: 'merge', in: [{ lot: 'A', mass: 100 }, { lot: 'B', mass: 50 }], out: [{ lot: 'C', mass: 150 }] });
  return { dir, s };
}

test('fault point 1a: crash mid-write before fsync leaves no half edge', () => {
  const { dir, s } = setup();
  const before = s.entries.length;
  // simulate a torn write: partial JSON line without newline, never fsynced
  const partial = canonical({ site: 'F', seq: 4, ts: 4, op: 'register', out: [{ lot: 'X', mass: 1 }] }).slice(0, 40);
  fs.appendFileSync(path.join(dir, 'edges.log'), partial);
  const report = s.resume();
  assert.ok(report.truncatedBytes > 0);
  const after = Store.init(dir);
  assert.equal(after.entries.length, before);
  assert.ok(!after.graph.lots.has('X')); // no half edge visible
  // log still accepts new entries after recovery
  after.add({ op: 'register', out: [{ lot: 'X', mass: 1 }] });
  assert.ok(Store.init(dir).graph.lots.has('X'));
});

test('fault point 1b: entry durable after fsync survives crash before snapshot', () => {
  const { dir, s } = setup();
  const before = s.entries.length;
  fs.unlinkSync(path.join(dir, 'snapshot.json')); // crash before snapshot rename
  const report = Store.init(dir).resume();
  assert.equal(report.snapshotRebuilt, true);
  assert.equal(Store.init(dir).entries.length, before); // entries intact
});

test('fault point 2: stray snapshot tmp from crashed rename is discarded', () => {
  const { dir, s } = setup();
  const good = fs.readFileSync(path.join(dir, 'snapshot.json'), 'utf8');
  fs.writeFileSync(path.join(dir, 'snapshot.json.tmp'), '{"count":999'); // torn tmp
  fs.writeFileSync(path.join(dir, 'snapshot.json'), 'garbage'); // and a corrupt live snapshot
  const report = s.resume();
  assert.deepEqual(report.removedTmp, ['snapshot.json.tmp']);
  assert.equal(report.snapshotRebuilt, true);
  assert.equal(fs.readFileSync(path.join(dir, 'snapshot.json'), 'utf8'), good); // rebuilt identical
});

test('fault point 3a: cert file without manifest commit is removed (no half cert)', () => {
  const { dir, s } = setup();
  const cert = buildCert(s.graph, 'C');
  fs.writeFileSync(path.join(dir, 'certs', cert.head + '.json'), canonical(cert) + '\n'); // crash before commit
  const report = s.resume();
  assert.deepEqual(report.removedOrphanCerts, [cert.head + '.json']);
  assert.equal(s.manifestEntries().length, 0);
});

test('fault point 3b: manifest commit without cert file is dropped', () => {
  const { dir, s } = setup();
  const cert = buildCert(s.graph, 'C');
  s.commitCert(cert);
  fs.unlinkSync(path.join(dir, 'certs', cert.head + '.json')); // cert lost after commit
  const report = Store.init(dir).resume();
  assert.deepEqual(report.droppedManifest, [cert.head]);
  assert.equal(Store.init(dir).manifestEntries().length, 0);
});

test('recovery then re-prove yields exactly one certificate', () => {
  const { dir, s } = setup();
  const cert = buildCert(s.graph, 'C');
  s.commitCert(cert);
  fs.unlinkSync(path.join(dir, 'certs', cert.head + '.json'));
  const r = Store.init(dir);
  r.resume();
  const again = r.commitCert(buildCert(r.graph, 'C'));
  assert.equal(again.committed, true);
  assert.equal(again.head, cert.head); // deterministic head
  assert.equal(Store.init(dir).manifestEntries().length, 1); // no double cert
});
