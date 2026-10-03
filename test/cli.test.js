import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCli } from '../src/cli.js';
import { sha256 } from '../src/canon.js';

const QUERY = {
  from: 'a',
  joins: [{ type: 'inner', table: 'b', on: [['a.k', 'b.k']] }],
  where: [{ col: 'a.x', op: '>=', value: 5 }],
  groupby: ['a.k'],
  aggregates: [
    { fn: 'sum', col: 'b.amt', as: 'total' },
    { fn: 'count', col: '*', as: 'n' },
  ],
  select: ['a.k', 'total', 'n'],
};

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prov-'));
  const dataDir = path.join(dir, 'data');
  fs.mkdirSync(dataDir);
  fs.writeFileSync(path.join(dataDir, 'a.json'), JSON.stringify({
    key: 'id',
    rows: [
      { id: 'a1', k: 'k1', x: 10 },
      { id: 'a2', k: 'k2', x: 3 },
      { id: 'a3', k: null, x: 7 },
      { id: 'a4', k: 'k4', x: null }, // unknown predicate -> partial group k4
    ],
  }));
  fs.writeFileSync(path.join(dataDir, 'b.json'), JSON.stringify({
    key: 'id',
    rows: [
      { id: 'b1', k: 'k1', amt: 5 },
      { id: 'b2', k: 'k1', amt: 7 },
      { id: 'b3', k: null, amt: 100 }, // never joins (NULL key)
      { id: 'b4', k: 'zz', amt: 50 }, // never joins (no match)
      { id: 'b5', k: 'k4', amt: 8 },
    ],
  }));
  const queryPath = path.join(dir, 'query.json');
  fs.writeFileSync(queryPath, JSON.stringify(QUERY));
  return { dir, dataDir, queryPath };
}

const run = (args, cwd) => runCli(args, { cwd, env: {} });

function execAndParse(dir, queryPath, dataDir) {
  const r = run(['exec', queryPath, dataDir], dir);
  assert.equal(r.code, 0, r.stderr);
  const lines = r.stdout.trim().split('\n').map((l) => JSON.parse(l));
  const rows = lines.filter((l) => l.outKey);
  const summary = lines.find((l) => l.summary).summary;
  return { rows, summary };
}

const keyOf = (rows, k) => rows.find((o) => o.values['a.k'] === k).outKey;

test('exec captures lineage; prove emits a verifiable proof', () => {
  const { dir, dataDir, queryPath } = setup();
  const { rows, summary } = execAndParse(dir, queryPath, dataDir);
  assert.equal(summary.outputs, 2);
  const k1 = keyOf(rows, 'k1');
  const r = run(['prove', k1], dir);
  assert.equal(r.code, 0, r.stderr);
  const proof = JSON.parse(r.stdout);
  assert.equal(proof.outKey, k1);
  assert.equal(proof.provenance, 'complete');
  assert.deepEqual(proof.row, { 'a.k': 'k1', total: 12, n: 2 });
  assert.deepEqual(
    proof.contributions.map((c) => `${c.table}:${c.key}`).sort(),
    ['a:a1', 'b:b1', 'b:b2'],
  );
  assert.match(proof.digest, /^[0-9a-f]{64}$/);
});

test('correcting an input that never joined must NOT mark the output affected', () => {
  const { dir, dataDir, queryPath } = setup();
  const { rows } = execAndParse(dir, queryPath, dataDir);
  const k1 = keyOf(rows, 'k1');
  for (const [table, key] of [['b', 'b3'], ['b', 'b4']]) {
    const c = run(['correct', table, key, '{"amt": 999}'], dir);
    assert.equal(c.code, 0, c.stderr);
  }
  const r = run(['reverify', k1], dir);
  assert.equal(r.code, 0, r.stderr);
  const cert = JSON.parse(r.stdout);
  assert.equal(cert.status, 'unaffected');
  assert.equal(cert.method, 'incremental-index');
  assert.equal(cert.corrections.length, 2);
});

test('correcting a contributing input marks the output affected', () => {
  const { dir, dataDir, queryPath } = setup();
  const { rows } = execAndParse(dir, queryPath, dataDir);
  const k1 = keyOf(rows, 'k1');
  assert.equal(run(['correct', 'b', 'b1', '{"amt": 6}'], dir).code, 0);
  const r = run(['reverify', k1], dir);
  assert.equal(r.code, 0, r.stderr);
  const cert = JSON.parse(r.stdout);
  assert.equal(cert.status, 'affected');
  assert.equal(cert.method, 're-execution');
});

test('partial lineage is reported explicitly and gated by E_PARTIAL_HIDDEN', () => {
  const { dir, dataDir, queryPath } = setup();
  const { rows, summary } = execAndParse(dir, queryPath, dataDir);
  const k4 = keyOf(rows, 'k4');
  assert.deepEqual(summary.partial, [k4]); // exec summary lists partial outputs
  assert.equal(rows.find((o) => o.outKey === k4).provenance, 'partial');

  const hidden = run(['prove', k4], dir);
  assert.equal(hidden.code, 4);
  assert.match(hidden.stderr, /E_PARTIAL_HIDDEN/);

  const shown = run(['prove', k4, '--allow-partial'], dir);
  assert.equal(shown.code, 0, shown.stderr);
  assert.equal(JSON.parse(shown.stdout).provenance, 'partial');

  const rvHidden = run(['reverify', k4], dir);
  assert.equal(rvHidden.code, 4);
  const rv = run(['reverify', k4, '--allow-partial'], dir);
  assert.equal(rv.code, 0, rv.stderr);
  assert.equal(JSON.parse(rv.stdout).provenance, 'partial'); // certificate reports it explicitly
});

test('a one-byte change to the proof file breaks verification (E_PROOF)', () => {
  const { dir, dataDir, queryPath } = setup();
  const { rows } = execAndParse(dir, queryPath, dataDir);
  const k1 = keyOf(rows, 'k1');
  const file = path.join(dataDir, '.prov', 'proofs', `${sha256(k1)}.json`);
  const buf = fs.readFileSync(file);
  buf[40] = buf[40] === 65 ? 66 : 65; // flip exactly one byte
  fs.writeFileSync(file, buf);
  const r = run(['prove', k1], dir);
  assert.equal(r.code, 3);
  assert.match(r.stderr, /E_PROOF/);
  const rv = run(['reverify', k1], dir);
  assert.equal(rv.code, 3);
  assert.match(rv.stderr, /E_PROOF/);
});

test('prove after a correction fails with E_STALE_PROOF until re-exec', () => {
  const { dir, dataDir, queryPath } = setup();
  const { rows } = execAndParse(dir, queryPath, dataDir);
  const k1 = keyOf(rows, 'k1');
  assert.equal(run(['correct', 'b', 'b4', '{"amt": 51}'], dir).code, 0);
  const stale = run(['prove', k1], dir);
  assert.equal(stale.code, 5);
  assert.match(stale.stderr, /E_STALE_PROOF/);
  execAndParse(dir, queryPath, dataDir); // re-exec refreshes the epoch
  const fresh = run(['prove', k1], dir);
  assert.equal(fresh.code, 0, fresh.stderr);
});

test('E_KEY on unknown output key, table, or row key', () => {
  const { dir, dataDir, queryPath } = setup();
  execAndParse(dir, queryPath, dataDir);
  const badOut = run(['prove', 'grp:["nope"]'], dir);
  assert.equal(badOut.code, 2);
  assert.match(badOut.stderr, /E_KEY/);
  const badTable = run(['correct', 'nope', 'x', '{"a":1}'], dir);
  assert.equal(badTable.code, 2);
  assert.match(badTable.stderr, /E_KEY/);
  const badKey = run(['correct', 'b', 'nope', '{"a":1}'], dir);
  assert.equal(badKey.code, 2);
  assert.match(badKey.stderr, /E_KEY/);
});

test('explain prints the plan and provenance summary', () => {
  const { dir, dataDir, queryPath } = setup();
  const { rows } = execAndParse(dir, queryPath, dataDir);
  const r = run(['explain'], dir);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /from: a/);
  assert.match(r.stdout, /join: inner b on a\.k = b\.k/);
  assert.match(r.stdout, /outputs: 2 \(partial: 1\)/);
  const r2 = run(['explain', keyOf(rows, 'k1')], dir);
  assert.equal(r2.code, 0, r2.stderr);
  assert.match(r2.stdout, /a "a1"/);
  assert.match(r2.stdout, /b "b1"/);
});
