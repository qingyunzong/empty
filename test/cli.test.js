import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runCli, EXIT_NEGATIVE, EXIT_HOLD } from '../src/cli.js';
import { canonicalize } from '../src/state.js';

function setup() {
  return mkdtempSync(join(tmpdir(), 'oee-cli-'));
}

// In-process CLI invocation: captures output, returns exit code.
function run(args) {
  let stdout = '';
  let stderr = '';
  const status = runCli(args, { stdout: (s) => { stdout += s; }, stderr: (s) => { stderr += s; } });
  return { status, stdout, stderr };
}

function writeJsonl(dir, name, events) {
  const path = join(dir, name);
  writeFileSync(path, events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return path;
}

const SHIFT = ['--window-start', '0', '--window-end', '28800', '--max-skew', '300'];

test('ingest two terminals, merge, oee reports a/p/q and empty pending', () => {
  const dir = setup();
  const t1 = join(dir, 't1.json');
  const t2 = join(dir, 't2.json');
  const e1 = writeJsonl(dir, 't1.jsonl', [
    { id: 'a1', type: 'count', counter: 'produced', node: 't1', delta: 40000, ts: 100 },
    { id: 'a2', type: 'count', counter: 'rejected', node: 't1', delta: 400, ts: 200 },
    { id: 'a3', type: 'downtime', node: 't1', start: 3600, end: 5400, ts: 3600 },
  ]);
  const e2 = writeJsonl(dir, 't2.jsonl', [
    { id: 'b1', type: 'count', counter: 'produced', node: 't2', delta: 17600, ts: 100 },
    { id: 'b2', type: 'downtime', node: 't2', start: 5000, end: 6200, ts: 5000 },
  ]);
  assert.equal(run(['ingest', '--state', t1, e1, ...SHIFT]).status, 0);
  assert.equal(run(['ingest', '--state', t2, e2, ...SHIFT]).status, 0);
  const out = join(dir, 'merged.json');
  assert.equal(run(['merge', '--state', out, t1, t2]).status, 0);

  const o = run(['oee', '--state', out, '--planned', '28800', '--ideal-rate', '2']);
  assert.equal(o.status, 0, o.stderr);
  const oee = JSON.parse(o.stdout);
  for (const key of ['available', 'performance', 'quality', 'oee', 'pending']) {
    assert.ok(key in oee, `output has ${key}`);
  }
  // merged downtime: [3600,5400] ∪ [5000,6200] = [3600,6200] => 2600s
  assert.equal(oee.downtime, 2600);
  assert.equal(oee.available, (28800 - 2600) / 28800);
  assert.equal(oee.produced, 57600);
  assert.equal(oee.rejected, 400);
  assert.equal(oee.quality, (57600 - 400) / 57600);
  assert.deepEqual(oee.pending, []);

  const h = run(['hold', '--state', out]);
  assert.equal(h.status, 0);
  assert.equal(JSON.parse(h.stdout).count, 0);
});

test('negative count exits 10', () => {
  const dir = setup();
  const state = join(dir, 's.json');
  const events = writeJsonl(dir, 'e.jsonl', [
    { id: 'p1', type: 'count', counter: 'produced', node: 't1', delta: 5, ts: 1 },
    { id: 'p2', type: 'count', counter: 'produced', node: 't1', delta: -10, ts: 2 },
  ]);
  const r = run(['ingest', '--state', state, events]);
  assert.equal(r.status, EXIT_NEGATIVE);
  assert.match(r.stderr, /negative/i);
});

test('hold events in final state exit 11 and list pending', () => {
  const dir = setup();
  const state = join(dir, 's.json');
  const events = writeJsonl(dir, 'e.jsonl', [
    { id: 'ok', type: 'count', counter: 'produced', node: 't1', delta: 100, ts: 100 },
    { id: 'skewed', type: 'count', counter: 'produced', node: 't1', delta: 50, ts: 999999 },
  ]);
  assert.equal(run(['ingest', '--state', state, events, ...SHIFT]).status, 0);
  const h = run(['hold', '--state', state]);
  const holds = JSON.parse(h.stdout);
  assert.equal(holds.count, 1);
  assert.equal(holds.pending[0].id, 'skewed');

  const o = run(['oee', '--state', state, '--planned', '28800', '--ideal-rate', '2']);
  assert.equal(o.status, EXIT_HOLD);
  const oee = JSON.parse(o.stdout);
  assert.deepEqual(oee.pending.map((p) => p.id), ['skewed']);
  assert.equal(oee.produced, 100, 'held event not counted');
});

test('merge is order-independent at the CLI level', () => {
  const dir = setup();
  const mk = (name, events) => {
    const s = join(dir, `${name}.json`);
    const f = writeJsonl(dir, `${name}.jsonl`, events);
    assert.equal(run(['ingest', '--state', s, f, ...SHIFT]).status, 0);
    return s;
  };
  const a = mk('a', [{ id: 'a1', type: 'count', counter: 'produced', node: 't1', delta: 10, ts: 1 }]);
  const b = mk('b', [{ id: 'b1', type: 'downtime', node: 't2', start: 10, end: 20, ts: 10 }]);
  const c = mk('c', [{ id: 'c1', type: 'revoke', target: 'b1', node: 't2', ts: 30 }]);
  const ab = join(dir, 'ab.json');
  const ba = join(dir, 'ba.json');
  assert.equal(run(['merge', '--state', ab, a, b, c]).status, 0);
  assert.equal(run(['merge', '--state', ba, c, b, a]).status, 0);
  const canon = (p) => JSON.stringify(canonicalize(JSON.parse(readFileSync(p, 'utf8'))));
  assert.equal(canon(ab), canon(ba));
  assert.deepEqual(JSON.parse(readFileSync(ab, 'utf8')).downtimes, {});
});

test('digest and repair converge two partial replicas', () => {
  const dir = setup();
  const all = [
    { id: 'e1', type: 'count', counter: 'produced', node: 't1', delta: 10, ts: 1000 },
    { id: 'e2', type: 'count', counter: 'produced', node: 't2', delta: 20, ts: 70000 },
    { id: 'e3', type: 'count', counter: 'rejected', node: 't1', delta: 3, ts: 130000 },
  ];
  const fa = writeJsonl(dir, 'a.jsonl', [all[0], all[2]]);
  const fb = writeJsonl(dir, 'b.jsonl', [all[1]]);
  const sa = join(dir, 'a.json');
  const sb = join(dir, 'b.json');
  run(['ingest', '--state', sa, fa]);
  run(['ingest', '--state', sb, fb]);
  const d1 = JSON.parse(run(['digest', '--state', sa, '--bucket', '60000']).stdout);
  const d2 = JSON.parse(run(['digest', '--state', sb, '--bucket', '60000']).stdout);
  assert.notDeepEqual(d1.buckets, d2.buckets);
  const r = run(['repair', '--state', sa, '--peer', sb, '--bucket', '60000']);
  assert.equal(r.status, 0);
  assert.deepEqual(JSON.parse(r.stdout).applied, ['e2']);
  const o = run(['oee', '--state', sa, '--planned', '28800', '--ideal-rate', '1']);
  assert.equal(JSON.parse(o.stdout).produced, 30);
});

test('usage errors exit 2', () => {
  assert.equal(run(['bogus']).status, 2);
  assert.equal(run(['ingest', '--state', 'x.json']).status, 2);
});
