import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run } from '../src/cli.js';
import { ProvError } from '../src/errors.js';

// The sandbox forbids spawning child processes, so the CLI is exercised
// in-process through its exported run() entry point (same code path as main).

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'provq-cli-'));
  const dataDir = path.join(root, 'data');
  const stateDir = path.join(root, 'state');
  fs.mkdirSync(dataDir);
  fs.writeFileSync(
    path.join(dataDir, 'emp.json'),
    JSON.stringify([
      { id: 1, dept: 10, name: 'ada', age: 36 },
      { id: 2, dept: 10, name: 'bob', age: null },
      { id: 3, dept: 99, name: 'cy', age: 41 },
    ]),
  );
  fs.writeFileSync(path.join(dataDir, 'dept.json'), JSON.stringify([{ id: 10, dname: 'sci' }]));
  const queryPath = path.join(root, 'query.json');
  fs.writeFileSync(
    queryPath,
    JSON.stringify({
      from: 'emp',
      joins: [{ table: 'dept', on: [['emp.dept', 'dept.id']] }],
      where: [{ col: 'emp.age', op: '>', value: 30 }],
      select: ['emp.name', 'dept.dname'],
    }),
  );
  return { root, dataDir, stateDir, queryPath };
}

test('CLI end-to-end: exec, prove, correct, reverify, explain', () => {
  const { dataDir, stateDir, queryPath } = setup();
  const S = ['--state', stateDir];

  const execRes = run(['exec', queryPath, dataDir, ...S]);
  assert.equal(execRes.ok, true);
  assert.equal(execRes.outputCount, 2);
  assert.equal(execRes.partials.length, 1); // bob: unknown predicate, reported explicitly
  assert.equal(execRes.partials[0].unknowns.length, 1);
  const adaKey = execRes.outputs.find((o) => o.row.name === 'ada').outKey;
  const bobKey = execRes.outputs.find((o) => o.row.name === 'bob').outKey;

  const proveAda = run(['prove', adaKey, ...S]);
  assert.equal(proveAda.partial, false);
  assert.equal(proveAda.proof.generation, 0);
  const proveBob = run(['prove', bobKey, ...S]);
  assert.equal(proveBob.partial, true);
  assert.equal(proveBob.unknowns.length, 1);

  // Correcting an un-joined input must not mark anything affected.
  const c1 = run(['correct', 'emp', '3', '{"name":"cy2"}', ...S]);
  assert.deepEqual(c1.affected, []);

  // Correcting a joined input affects its output and stales the proof.
  const c2 = run(['correct', 'emp', '1', '{"name":"ada2"}', ...S]);
  assert.deepEqual(c2.affected, [adaKey]);
  assert.throws(() => run(['prove', adaKey, ...S]), (e) => e.code === 'E_STALE_PROOF');

  const rv = run(['reverify', adaKey, ...S]);
  assert.equal(rv.certificate.status, 'affected');
  assert.deepEqual(rv.certificate.row, { name: 'ada2', dname: 'sci' });

  const rvBob = run(['reverify', bobKey, ...S]);
  assert.equal(rvBob.certificate.status, 'unaffected');
  assert.equal(rvBob.certificate.partial, true);
});

test('CLI reverify --all refuses to hide partial provenance', () => {
  const { dataDir, stateDir, queryPath } = setup();
  const S = ['--state', stateDir];
  run(['exec', queryPath, dataDir, ...S]);
  assert.throws(
    () => run(['reverify', '--all', ...S]),
    (e) => e instanceof ProvError && e.code === 'E_PARTIAL_HIDDEN' && e.details.partials.length === 1,
  );
});

test('CLI explain shows lineage and state summary', () => {
  const { dataDir, stateDir, queryPath } = setup();
  const S = ['--state', stateDir];
  const execRes = run(['exec', queryPath, dataDir, ...S]);
  const adaKey = execRes.outputs.find((o) => o.row.name === 'ada').outKey;
  run(['correct', 'emp', '1', '{"name":"ada2"}', ...S]);
  run(['reverify', adaKey, ...S]);
  const info = run(['explain', adaKey, ...S]);
  assert.deepEqual(info.byTable, { dept: ['dept:10'], emp: ['emp:1'] });
  assert.equal(info.corrections.length, 1);
  assert.equal(info.certificate.status, 'affected');
  const summary = run(['explain', ...S]);
  assert.equal(summary.outputs, 2);
  assert.equal(summary.generation, 1);
});

test('CLI error codes: E_KEY for unknown outKey, E_PROOF for tampered proof', () => {
  const { dataDir, stateDir, queryPath } = setup();
  const S = ['--state', stateDir];
  const execRes = run(['exec', queryPath, dataDir, ...S]);
  const adaKey = execRes.outputs.find((o) => o.row.name === 'ada').outKey;
  assert.throws(() => run(['prove', 'row|nope', ...S]), (e) => e.code === 'E_KEY');

  const proofsDir = path.join(stateDir, 'proofs');
  const file = fs.readdirSync(proofsDir).find((f) => {
    const p = JSON.parse(fs.readFileSync(path.join(proofsDir, f), 'utf8'));
    return p.outKey === adaKey;
  });
  const filePath = path.join(proofsDir, file);
  const text = fs.readFileSync(filePath, 'utf8');
  fs.writeFileSync(filePath, text.replace('"ada"', '"adx"')); // one byte changed
  assert.throws(() => run(['prove', adaKey, ...S]), (e) => e.code === 'E_PROOF');
});
