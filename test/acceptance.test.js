// End-to-end acceptance tests driving the real CLI (runCli) in a temp directory.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCli } from '../src/cli.js';

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wxmerge-'));
  const run = (args, { expectFail = false } = {}) => {
    const res = runCli(args.map((a) => (a.endsWith('.jsonl') ? path.join(dir, a) : a)));
    if (!expectFail && res.code !== 0) {
      assert.fail(`expected success, got code ${res.code}: ${res.stderr}`);
    }
    if (expectFail && res.code === 0) {
      assert.fail(`expected failure, got success: ${res.stdout}`);
    }
    return res;
  };
  const write = (name, records) => {
    fs.writeFileSync(
      path.join(dir, name),
      records.map((r) => JSON.stringify(r)).join('\n') + '\n',
    );
  };
  const query = (store, extra = []) =>
    run(['query', '--store', store, ...extra])
      .stdout.split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  return { dir, run, write, query };
}

const T = (d, h = 0) =>
  `2026-01-0${d}T0${h}:00:00.000Z`;

test('acceptance 1: out-of-order + duplicate ingest yields identical query', () => {
  const { run, write, query } = setup();
  const stream = [
    { t: T(1, 1), delta: -1.5, seq: 1 },
    { t: T(1, 2), delta: 2.0, seq: 2 },
    { t: T(1, 3), delta: -0.5, seq: 3 },
    { t: T(1, 4), delta: 4.2, seq: 4 },
    { t: T(1, 5), delta: 0.1, seq: 5 },
  ];
  write('ordered.jsonl', stream);
  write('shuffled.jsonl', [stream[3], stream[0], stream[4], stream[1], stream[2]]);

  run(['ingest', '--store', 's1.jsonl', '--site', 'A', '--input', 'ordered.jsonl']);
  // other store: shuffled, then duplicated twice (mixed order again)
  run(['ingest', '--store', 's2.jsonl', '--site', 'A', '--input', 'shuffled.jsonl']);
  const dup = run(['ingest', '--store', 's2.jsonl', '--site', 'A', '--input', 'ordered.jsonl']);
  assert.equal(JSON.parse(dup.stdout).added, 0, 're-ingest must be a no-op');
  run(['ingest', '--store', 's2.jsonl', '--site', 'A', '--input', 'shuffled.jsonl']);

  assert.deepEqual(query('s2.jsonl'), query('s1.jsonl'));
  assert.equal(query('s1.jsonl').length, 5);
});

test('acceptance 2: out-of-range correction goes to invalid, never silently dropped', () => {
  const { run, write, query } = setup();
  write('s.jsonl', [
    { t: T(2, 1), delta: -18.5, seq: 1 }, // negative AND out of valid range
    { t: T(2, 2), delta: 1.0, seq: 2 },
  ]);
  const res = JSON.parse(run(['ingest', '--store', 'storeB.jsonl', '--site', 'B', '--input', 's.jsonl']).stdout);
  assert.equal(res.invalid, 1);
  // default query filters the invalid correction
  assert.deepEqual(query('storeB.jsonl'), [{ site: 'B', t: T(2, 2), delta: 1.0 }]);
  // but the evidence is retained and visible on demand
  const all = query('storeB.jsonl', ['--include-invalid']);
  assert.deepEqual(all[0], { site: 'B', t: T(2, 1), delta: -18.5, valid: false });
  // hard-range violations are rejected with BAD_RANGE
  write('bad.jsonl', [{ t: T(2, 3), delta: 999, seq: 3 }]);
  const bad = run(['ingest', '--store', 'storeB.jsonl', '--site', 'B', '--input', 'bad.jsonl'], { expectFail: true });
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /"error":"BAD_RANGE"/);
});

test('acceptance 3: tombstone blocks resurrection by a stale replica', () => {
  const { dir, run, write, query } = setup();
  write('put.jsonl', [{ t: T(3, 1), delta: 2.5, seq: 1 }]);
  run(['ingest', '--store', 'main.jsonl', '--site', 'C', '--input', 'put.jsonl']);
  fs.copyFileSync(path.join(dir, 'main.jsonl'), path.join(dir, 'stale.jsonl'));
  write('del.jsonl', [{ t: T(3, 1), delete: true, seq: 2 }]);
  run(['ingest', '--store', 'main.jsonl', '--site', 'C', '--input', 'del.jsonl']);
  assert.equal(query('main.jsonl').length, 0);

  // merge stale replica back, in both orders: key must stay deleted
  run(['merge', '--out', 'm1.jsonl', 'stale.jsonl', 'main.jsonl']);
  run(['merge', '--out', 'm2.jsonl', 'main.jsonl', 'stale.jsonl']);
  assert.equal(query('m1.jsonl').length, 0);
  assert.equal(query('m2.jsonl').length, 0);

  // direct re-put on the tombstoned key is rejected
  write('reput.jsonl', [{ t: T(3, 1), delta: 7.7, seq: 3 }]);
  const hit = run(['ingest', '--store', 'main.jsonl', '--site', 'C', '--input', 'reput.jsonl'], { expectFail: true });
  assert.match(hit.stderr, /"error":"TOMBSTONE_HIT"/);
  assert.equal(query('main.jsonl').length, 0, 'tombstone still intact');
});

test('acceptance 4: visible query is equivalent before and after compact', () => {
  const { run, write, query } = setup();
  // build a shared store where both sites gossip (so the min vector advances)
  write('a1.jsonl', [
    { t: T(4, 1), delta: 1.1, seq: 1 },
    { t: T(4, 2), delta: 25.0, seq: 2 }, // invalid evidence
  ]);
  write('b1.jsonl', [
    { t: T(4, 1), delta: -0.4, seq: 1 },
    { t: T(4, 3), delta: 3.3, seq: 2 },
  ]);
  write('a2.jsonl', [{ t: T(4, 1), delete: true, seq: 3 }]); // A deletes its first key
  write('b2.jsonl', [{ t: T(4, 4), delta: 0.9, seq: 3 }]); // B writes after seeing the delete

  run(['ingest', '--store', 'hub.jsonl', '--site', 'A', '--input', 'a1.jsonl']);
  run(['ingest', '--store', 'hub.jsonl', '--site', 'B', '--input', 'b1.jsonl']);
  run(['ingest', '--store', 'hub.jsonl', '--site', 'A', '--input', 'a2.jsonl']);
  run(['ingest', '--store', 'hub.jsonl', '--site', 'B', '--input', 'b2.jsonl']);

  const beforeDefault = query('hub.jsonl');
  const beforeAll = query('hub.jsonl', ['--include-invalid']);
  const res = JSON.parse(run(['compact', '--store', 'hub.jsonl']).stdout);
  assert.ok(res.dropped > 0, 'compact should collect covered events');

  assert.deepEqual(query('hub.jsonl'), beforeDefault, 'default query unchanged');
  assert.deepEqual(query('hub.jsonl', ['--include-invalid']), beforeAll, 'evidence view unchanged');

  // and the compacted store still merges cleanly with a stale pre-delete snapshot
  write('late.jsonl', [{ t: T(4, 5), delta: 5.5, seq: 4 }]);
  run(['ingest', '--store', 'b.jsonl', '--site', 'B', '--input', 'b1.jsonl']);
  run(['ingest', '--store', 'b.jsonl', '--site', 'B', '--input', 'b2.jsonl']);
  run(['merge', '--out', 'final.jsonl', 'hub.jsonl', 'b.jsonl']);
  const rows = query('final.jsonl');
  assert.ok(!rows.some((r) => r.site === 'A' && r.t === T(4, 1)), 'deleted key stays deleted');
});
