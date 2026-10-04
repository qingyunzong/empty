import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir, cli, addLot, addEvent } from '../testkit/helpers.js';
import { Store } from '../src/store.js';
import { makeLot, makeEvent, sha256, canonical, LotError } from '../src/core.js';
import { buildCert, verifyCert } from '../src/cert.js';

function buildStore() {
  const dir = tmpdir();
  const s = Store.open(dir);
  const add = (rec) => s.appendRecord(rec);
  add(makeLot({ id: 'A', mass: 100, unit: 'kg', site: 'f1', seq: s.nextSeq('f1'), createdAt: 1 }));
  add(makeLot({ id: 'B', mass: 50, unit: 'kg', site: 'f1', seq: s.nextSeq('f1'), createdAt: 1 }));
  add(makeEvent({ op: 'merge', inputs: [{ lot: 'A', mass: 60 }, { lot: 'B', mass: 50 }], outputs: [{ lot: 'C', mass: 110 }], ts: 2, site: 'f1', seq: s.nextSeq('f1') }));
  add(makeEvent({ op: 'split', inputs: [{ lot: 'C', mass: 110 }], outputs: [{ lot: 'D', mass: 70 }, { lot: 'E', mass: 40 }], ts: 3, site: 'f1', seq: s.nextSeq('f1') }));
  add(makeEvent({ op: 'relabel', inputs: [{ lot: 'D', mass: 70 }], outputs: [{ lot: 'F', mass: 70 }], ts: 4, site: 'f1', seq: s.nextSeq('f1') }));
  return { s, dir };
}

test('prove builds a certificate that verifies', () => {
  const { s } = buildStore();
  const cert = buildCert(s.graph, 'F');
  const result = verifyCert(cert, { graph: s.graph });
  assert.equal(result.ok, true);
  assert.ok(cert.lots.length >= 5);
  assert.equal(cert.certId, cert.chain);
  s.close();
});

test('tampered certificate is rejected with exit 7', () => {
  const { s } = buildStore();
  const cert = buildCert(s.graph, 'F');
  cert.edges[0].mass += 1;
  assert.throws(() => verifyCert(cert), (e) => e instanceof LotError && e.code === 7);
  s.close();
});

test('certificate with a removed edge is rejected (missing edge)', () => {
  const { s } = buildStore();
  const cert = buildCert(s.graph, 'F');
  cert.edges = cert.edges.filter((e) => !(e.from === 'A' && e.to === 'C'));
  // recompute the chain honestly so only the structural check can catch it
  let h = sha256('lot-genealogy/cert/v1');
  for (const rec of cert.lots) h = sha256(h + canonical({ kind: 'lot', ...rec }));
  for (const rec of cert.events) h = sha256(h + canonical({ kind: 'event', ...rec }));
  for (const rec of cert.edges) h = sha256(h + canonical({ kind: 'edge', ...rec }));
  h = sha256(h + canonical({ boundary: cert.boundary }));
  cert.chain = h;
  cert.certId = h;
  assert.throws(() => verifyCert(cert), (e) => e.code === 7 && /missing edge/i.test(e.message));
  s.close();
});

test('certificate containing a cycle is rejected', () => {
  const { s } = buildStore();
  const cert = buildCert(s.graph, 'F');
  // inject a back edge F -> A and recompute the chain honestly
  const back = { id: sha256('back'), event: 'evil', op: 'split', from: 'F', to: 'A', mass: 1, ts: 9, site: 'f1', seq: 99 };
  cert.edges.push(back);
  let h = sha256('lot-genealogy/cert/v1');
  for (const rec of cert.lots) h = sha256(h + canonical({ kind: 'lot', ...rec }));
  for (const rec of cert.events) h = sha256(h + canonical({ kind: 'event', ...rec }));
  for (const rec of cert.edges) h = sha256(h + canonical({ kind: 'edge', ...rec }));
  h = sha256(h + canonical({ boundary: cert.boundary }));
  cert.chain = h;
  cert.certId = h;
  assert.throws(() => verifyCert(cert), (e) => e.code === 7 && /cycle/i.test(e.message));
  s.close();
});

test('prove exits 3 when pending events touch the ancestry', () => {
  const { s } = buildStore();
  s.appendRecord(makeEvent({ op: 'merge', inputs: [{ lot: 'GHOST', mass: 1 }, { lot: 'F', mass: 1 }], outputs: [{ lot: 'Z', mass: 2 }], ts: 5, site: 'f1', seq: s.nextSeq('f1') }));
  assert.throws(() => buildCert(s.graph, 'F'), (e) => e.code === 3);
  s.close();
});

test('CLI end-to-end: prove then verify, tamper detected with exit 7', () => {
  const dir = tmpdir();
  assert.equal(addLot(dir, 'f1', 'A', 100, 1).code, 0);
  assert.equal(addLot(dir, 'f1', 'B', 50, 1).code, 0);
  assert.equal(addEvent(dir, 'f1', 'merge', [['A', 60], ['B', 50]], [['C', 110]], 2).code, 0);
  const certPath = path.join(dir, 'cert.json');
  const proved = cli(['prove', '--dir', dir, '--lot', 'C', '--out', certPath]);
  assert.equal(proved.code, 0, proved.stderr);

  const ok = cli(['verify', '--dir', dir, '--cert', certPath]);
  assert.equal(ok.code, 0, ok.stderr);
  assert.equal(ok.json().ok, true);

  const cert = JSON.parse(fs.readFileSync(certPath, 'utf8'));
  cert.lots[0].mass += 5;
  const tamperedPath = path.join(dir, 'tampered.json');
  fs.writeFileSync(tamperedPath, JSON.stringify(cert));
  const bad = cli(['verify', '--dir', dir, '--cert', tamperedPath]);
  assert.equal(bad.code, 7);
  assert.equal(bad.errJson().code, 7);
});
