import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import { buildCert, verifyCert } from '../src/cert.js';
import { EXIT } from '../src/errors.js';

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lg-cert-'));
  const s = Store.init(dir, { site: 'F' });
  s.add({ op: 'register', out: [{ lot: 'A', mass: 100 }] });
  s.add({ op: 'register', out: [{ lot: 'B', mass: 50 }] });
  s.add({ op: 'merge', in: [{ lot: 'A', mass: 100 }, { lot: 'B', mass: 50 }], out: [{ lot: 'C', mass: 150 }] });
  s.add({ op: 'split', in: [{ lot: 'C', mass: 150 }], out: [{ lot: 'D', mass: 90 }, { lot: 'E', mass: 60 }] });
  s.add({ op: 'relabel', in: [{ lot: 'E', mass: 60 }], out: [{ lot: 'E2', mass: 60 }] });
  return { dir, s };
}

test('prove then verify round-trips', () => {
  const { s } = setup();
  const cert = buildCert(s.graph, 'D');
  const r = verifyCert(cert);
  assert.equal(r.ok, true);
  assert.equal(r.ops, 4); // register A, register B, merge, split
  assert.equal(r.lots, 4); // A B C D (E is not an ancestor of D)
});

test('tampered entry breaks the hash chain with code 7', () => {
  const { s } = setup();
  const cert = buildCert(s.graph, 'D');
  const evil = JSON.parse(JSON.stringify(cert));
  evil.entries.find((e) => e.kind === 'lot' && e.lot === 'A').mass = 999;
  assert.throws(() => verifyCert(evil), (e) => e.code === EXIT.CERT && /tampering/.test(e.message));
});

test('removed edge (dropped op) is detected with code 7', () => {
  const { s } = setup();
  const cert = buildCert(s.graph, 'D');
  const evil = JSON.parse(JSON.stringify(cert));
  const i = evil.entries.findIndex((e) => e.kind === 'op' && e.entry.op === 'merge');
  evil.entries.splice(i, 1);
  evil.count = evil.entries.length;
  assert.throws(() => verifyCert(evil), (e) => e.code === EXIT.CERT);
});

test('certificate with a cycle is rejected even with a valid chain', async () => {
  const { canonical, sha256hex } = await import('../src/canon.js');
  // hand-crafted cyclic "genealogy": relabel A->B and B->A
  const ops = [
    { site: 'X', seq: 1, ts: 1, op: 'register', in: [], out: [{ lot: 'A', mass: 10 }], id: 'r1' },
    { site: 'X', seq: 2, ts: 2, op: 'relabel', in: [{ lot: 'A', mass: 10 }], out: [{ lot: 'B', mass: 10 }], id: 'r2' },
    { site: 'X', seq: 3, ts: 3, op: 'relabel', in: [{ lot: 'B', mass: 10 }], out: [{ lot: 'A', mass: 10 }], id: 'r3' },
  ];
  const entries = [
    { kind: 'lot', lot: 'A', mass: 10, createdTs: 1 },
    { kind: 'lot', lot: 'B', mass: 10, createdTs: 2 },
    ...ops.map((entry) => ({ kind: 'op', entry })),
  ];
  let head = sha256hex('lot-genealogy:cert:v1');
  for (const e of entries) head = sha256hex(head + ':' + sha256hex(canonical(e)));
  const cert = { version: 1, root: 'A', count: entries.length, entries, head };
  assert.throws(() => verifyCert(cert), (e) => e.code === EXIT.CERT);
});

test('prove on pending-blocked lot exits with code 3', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lg-cert-'));
  const s = Store.init(dir, { site: 'F' });
  s.add({ op: 'merge', in: [{ lot: 'U1', mass: 5 }, { lot: 'U2', mass: 5 }], out: [{ lot: 'G', mass: 10 }] });
  assert.throws(() => buildCert(s.graph, 'G'), (e) => e.code === EXIT.PENDING);
});

test('commit is idempotent: no double certificate', () => {
  const { s } = setup();
  const cert = buildCert(s.graph, 'D');
  const c1 = s.commitCert(cert);
  const c2 = s.commitCert(cert);
  assert.equal(c1.committed, true);
  assert.equal(c2.committed, false);
  assert.equal(s.manifestEntries().filter((m) => m.head === cert.head).length, 1);
});
