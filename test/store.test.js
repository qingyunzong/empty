import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import { ProvError, E_KEY, E_PROOF, E_STALE_PROOF, E_PARTIAL_HIDDEN } from '../src/errors.js';

const QUERY = {
  from: 'emp',
  joins: [{ table: 'dept', on: [['emp.dept', 'dept.id']] }],
  where: [{ col: 'emp.age', op: '>', value: 30 }],
  select: ['emp.name', 'dept.dname'],
};

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'provq-'));
  const dataDir = path.join(root, 'data');
  const stateDir = path.join(root, 'state');
  fs.mkdirSync(dataDir);
  fs.writeFileSync(
    path.join(dataDir, 'emp.json'),
    JSON.stringify([
      { id: 1, dept: 10, name: 'ada', age: 36 },
      { id: 2, dept: 10, name: 'bob', age: null },
      { id: 3, dept: 99, name: 'cy', age: 41 },
      { id: 4, dept: null, name: 'di', age: 28 },
    ]),
  );
  fs.writeFileSync(
    path.join(dataDir, 'dept.json'),
    JSON.stringify([
      { id: 10, dname: 'sci' },
      { id: 20, dname: 'ops' },
    ]),
  );
  const store = new Store(stateDir);
  const { outputs } = store.exec(QUERY, dataDir);
  const byName = (n) => outputs.find((o) => o.row.name === n);
  return { root, dataDir, stateDir, store, outputs, byName };
}

function proofFile(store, outKey) {
  const manifest = store.loadManifest();
  assert.ok(manifest.outputs.includes(outKey));
  return store.fileFor('proofs', outKey);
}

test('exec captures lineage; partial provenance is reported explicitly', () => {
  const { outputs, byName } = setup();
  assert.equal(outputs.length, 2); // cy (no dept 99) and di (NULL key) unjoined
  const ada = byName('ada');
  assert.deepEqual(ada.provenance.contributors, ['dept:10', 'emp:1']);
  assert.equal(ada.provenance.partial, false);
  const bob = byName('bob');
  assert.equal(bob.provenance.partial, true);
  assert.deepEqual(bob.provenance.unknowns[0].inputs, ['emp:2']);
});

test('prove verifies a fresh proof; unknown outKey raises E_KEY', () => {
  const { store, byName } = setup();
  const proof = store.prove(byName('ada').outKey);
  assert.equal(proof.generation, 0);
  assert.equal(proof.provenance.partial, false);
  assert.throws(() => store.prove('row|nope'), (e) => e.code === E_KEY);
});

test('a one-byte modification of the proof file fails verification', () => {
  const { store, byName } = setup();
  const outKey = byName('ada').outKey;
  const file = proofFile(store, outKey);

  // Case 1: flip one byte inside a JSON string value (file stays valid JSON).
  const text = fs.readFileSync(file, 'utf8');
  const i = text.indexOf('ada');
  assert.ok(i > 0);
  fs.writeFileSync(file, `${text.slice(0, i)}x${text.slice(i + 1)}`);
  assert.throws(() => store.prove(outKey), (e) => e.code === E_PROOF);

  // Case 2: corrupt one byte so the file is no longer JSON.
  const { store: store2, byName: byName2 } = setup();
  const outKey2 = byName2('ada').outKey;
  const file2 = proofFile(store2, outKey2);
  const buf = fs.readFileSync(file2);
  buf[0] = buf[0] === 123 ? 125 : 123; // '{' <-> '}'
  fs.writeFileSync(file2, buf);
  assert.throws(() => store2.prove(outKey2), (e) => e.code === E_PROOF);
});

test('correcting an un-joined input marks nothing affected', () => {
  const { store } = setup();
  const r1 = store.correct('emp', '3', { name: 'cy2' }); // dept 99 never joined
  assert.deepEqual(r1.affected, []);
  const r2 = store.correct('emp', '4', { age: 35 }); // NULL dept never joined
  assert.deepEqual(r2.affected, []);
  const r3 = store.correct('dept', '20', { dname: 'ops2' }); // no emp references dept 20
  assert.deepEqual(r3.affected, []);
});

test('correcting a joined input marks its outputs affected; proofs go stale', () => {
  const { store, byName } = setup();
  const ada = byName('ada');
  const r = store.correct('emp', '1', { name: 'ada2' });
  assert.deepEqual(r.affected, [ada.outKey]);
  assert.throws(() => store.prove(ada.outKey), (e) => e.code === E_STALE_PROOF);
  const cert = store.reverify(ada.outKey);
  assert.equal(cert.status, 'affected');
  assert.deepEqual(cert.row, { name: 'ada2', dname: 'sci' });
  assert.deepEqual(cert.previousRow, { name: 'ada', dname: 'sci' });
  const proof = store.prove(ada.outKey); // fresh again after reverify
  assert.equal(proof.generation, r.generation);
});

test('correction that does not change an output yields an unaffected certificate', () => {
  const { store, byName } = setup();
  const ada = byName('ada');
  store.correct('emp', '1', { age: 40 }); // still > 30, same output
  const cert = store.reverify(ada.outKey);
  assert.equal(cert.status, 'unaffected');
  assert.equal(cert.corrections.length, 1); // the correction is still reported
});

test('reverify after an unrelated correction yields unaffected and refreshes the proof', () => {
  const { store, byName } = setup();
  const ada = byName('ada');
  store.correct('dept', '20', { dname: 'ops2' });
  assert.throws(() => store.prove(ada.outKey), (e) => e.code === E_STALE_PROOF);
  const cert = store.reverify(ada.outKey);
  assert.equal(cert.status, 'unaffected');
  assert.equal(cert.partial, false);
  assert.ok(store.prove(ada.outKey));
});

test('partial lineage is explicit in certificates; blanket reverify is refused', () => {
  const { store, byName } = setup();
  const bob = byName('bob');
  store.correct('emp', '2', { age: null });
  const cert = store.reverify(bob.outKey);
  assert.equal(cert.status, 'unaffected');
  assert.equal(cert.partial, true); // partiality is never hidden
  assert.equal(cert.unknowns.length, 1);
  assert.throws(
    () => store.reverifyAll(),
    (e) => e.code === E_PARTIAL_HIDDEN && e.details.partials.includes(bob.outKey),
  );
});

test('reverifyAll issues a blanket certificate when nothing is partial', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'provq-'));
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(dataDir);
  fs.writeFileSync(
    path.join(dataDir, 't.json'),
    JSON.stringify([
      { id: 1, g: 'a', v: 5 },
      { id: 2, g: 'a', v: 7 },
    ]),
  );
  const store = new Store(path.join(root, 'state'));
  store.exec(
    { from: 't', groupBy: ['t.g'], aggregates: [{ fn: 'sum', col: 't.v', as: 'total' }] },
    dataDir,
  );
  store.correct('t', '1', { v: 6 });
  const summary = store.reverifyAll();
  assert.equal(summary.total, 1);
  assert.deepEqual(summary.affected, ['grp|["a"]']);
  assert.deepEqual(summary.unaffected, []);
});

test('correct raises E_KEY for unknown table, key, or key-column patch', () => {
  const { store } = setup();
  assert.throws(() => store.correct('nope', '1', {}), (e) => e.code === E_KEY);
  assert.throws(() => store.correct('emp', '999', { name: 'x' }), (e) => e.code === E_KEY);
  assert.throws(() => store.correct('emp', '1', { id: 5 }), (e) => e.code === E_KEY);
});

test('explain reports lineage, corrections, and certificates per output', () => {
  const { store, byName } = setup();
  const ada = byName('ada');
  store.correct('emp', '1', { name: 'ada2' });
  store.reverify(ada.outKey);
  const info = store.explain(ada.outKey);
  assert.deepEqual(info.byTable, { dept: ['dept:10'], emp: ['emp:1'] });
  assert.equal(info.corrections.length, 1);
  assert.equal(info.certificate.status, 'affected');
  const summary = store.explain();
  assert.equal(summary.outputs, 2);
  assert.equal(summary.generation, 1);
});

test('tampered proof also fails reverify (integrity checked before staleness)', () => {
  const { store, byName } = setup();
  const ada = byName('ada');
  store.correct('emp', '1', { name: 'ada2' });
  const file = proofFile(store, ada.outKey);
  const text = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, text.replace('"ada"', '"zzz"'));
  assert.throws(() => store.reverify(ada.outKey), (e) => e.code === E_PROOF);
});

test('operations without prior exec raise E_PROOF', () => {
  const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'provq-empty-')));
  assert.throws(() => store.prove('row|x'), (e) => e.code === E_PROOF);
  assert.throws(() => store.correct('emp', '1', {}), (e) => e.code === E_PROOF);
});
