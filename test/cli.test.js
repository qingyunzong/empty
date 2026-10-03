import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../src/cli.js';

function run(args, { expectFail = false } = {}) {
  const { code, stdout, stderr } = runCli(args);
  if (expectFail) {
    assert.notEqual(code, 0, `expected failure, got stdout: ${stdout}`);
    return JSON.parse(stderr);
  }
  assert.equal(code, 0, `expected success, got stderr: ${stderr}`);
  return JSON.parse(stdout);
}

test('CLI end-to-end: add, query, search, prove, verify', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'lineage-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = join(dir, 'log.jsonl');

  run(['--db', db, 'add', '--id', 'A', '--text', 'stainless steel rod', '--ts', '1']);
  run(['--db', db, 'add', '--id', 'B', '--parents', 'A', '--text', 'welded steel frame', '--ts', '2']);
  run(['--db', db, 'add', '--id', 'C', '--parents', 'B', '--text', 'painted frame', '--ts', '3']);

  assert.deepEqual(run(['--db', db, 'ancestors', '--id', 'C']).live.sort(), ['A', 'B']);
  assert.deepEqual(run(['--db', db, 'descendants', '--id', 'A']).live.sort(), ['B', 'C']);
  assert.deepEqual(run(['--db', db, 'search', '--phrase', 'steel rod']).live, ['A']);
  assert.deepEqual(
    run(['--db', db, 'search', '--near', 'steel frame', '--dist', '3']).live.sort(),
    ['B'], // both terms must co-occur within dist; A has no 'frame'
  );

  // correction via CLI, old slice intact
  run(['--db', db, 'add', '--id', 'D', '--text', 'alt material', '--ts', '4']);
  run(['--db', db, 'correct', '--child', 'B', '--from', 'A', '--to', 'D', '--ts', '5']);
  assert.deepEqual(run(['--db', db, 'ancestors', '--id', 'B', '--at', '4']).live, ['A']);
  assert.deepEqual(run(['--db', db, 'ancestors', '--id', 'B']).live, ['D']);

  // inclusion proof round-trip
  const proof = run(['--db', db, 'prove', '--id', 'B']);
  assert.equal(proof.cert.id, 'B');
  const ok = run(['--db', db, 'verify', '--proof', JSON.stringify(proof)]);
  assert.equal(ok.ok, true);
  assert.equal(ok.included, true);
  assert.equal(run(['--db', db, 'root']).root, proof.root);

  // deletion: masked in queries, provable via certificate
  run(['--db', db, 'delete', '--id', 'B', '--ts', '6']);
  const anc = run(['--db', db, 'ancestors', '--id', 'C']);
  assert.deepEqual(anc.masked, ['B']);
  const tombProof = run(['--db', db, 'prove', '--id', 'B']);
  assert.equal(tombProof.cert.tombstone, 1);
  assert.equal(run(['--db', db, 'verify', '--proof', JSON.stringify(tombProof)]).ok, true);

  // tampered proof -> E_PROOF, non-zero exit
  const bad = { ...tombProof, root: '0'.repeat(64) };
  const err = run(['--db', db, 'verify', '--proof', JSON.stringify(bad)], { expectFail: true });
  assert.equal(err.error, 'E_PROOF');

  // cycle and time errors via CLI
  const cyc = run(
    ['--db', db, 'correct', '--child', 'D', '--from', 'D', '--to', 'C', '--ts', '7'],
    { expectFail: true },
  );
  assert.equal(cyc.error, 'E_CYCLE');
  const tim = run(['--db', db, 'add', '--id', 'Z', '--text', 'late', '--ts', '1'], {
    expectFail: true,
  });
  assert.equal(tim.error, 'E_TIME');
});
