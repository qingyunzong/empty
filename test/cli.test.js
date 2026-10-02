import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../cli.js';
import { makeInstance } from '../examples/gen.mjs';

// The sandbox forbids spawning child processes, so the CLI entry (`run`) is
// exercised in-process with captured io; exit-code semantics are identical.

function invoke(args) {
  const out = [];
  const err = [];
  const code = run(args, { out: (s) => out.push(s), err: (s) => err.push(s) });
  return { code, stdout: out.join('\n'), stderr: err.join('\n') };
}

function tempJson(obj) {
  const dir = mkdtempSync(join(tmpdir(), 'mold-'));
  const file = join(dir, 'input.json');
  writeFileSync(file, typeof obj === 'string' ? obj : JSON.stringify(obj));
  return file;
}

test('valid input: exit 0 with FEASIBLE schedule and lexicographic objective', () => {
  const r = invoke([tempJson(makeInstance(42, 12))]);
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.status, 'FEASIBLE');
  assert.deepEqual(out.objective, { makespan: 38, energy: 23, tardiness: 23 });
  assert.equal(out.schedule.length, 12);
  assert.equal(out.tiedOptima, out.solutions.length);
  // schedule is internally consistent: chained starts and makespan
  let prev = null;
  for (const entry of out.schedule) {
    if (prev) assert.equal(entry.start, prev.completion + entry.setup);
    prev = entry;
  }
  assert.equal(out.schedule.at(-1).completion, out.objective.makespan);
});

test('invalid setup matrix: ERR_SCHEMA on stderr and exit code 2', () => {
  const bad = makeInstance(1, 4);
  bad.setup = [[0, 1], [1, 0]]; // 3 distinct molds but a 2x2 matrix
  const r = invoke([tempJson(bad)]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /ERR_SCHEMA/);
  assert.equal(r.stdout, '');
});

test('malformed JSON: ERR_SCHEMA and exit code 2', () => {
  const r = invoke([tempJson('{not json')]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /ERR_SCHEMA/);
});

test('missing job fields: ERR_SCHEMA and exit code 2', () => {
  const bad = { jobs: [{ due: 1, work: 2, mold: 'A' }], setup: [[0]], energyBudget: 5 };
  const r = invoke([tempJson(bad)]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /ERR_SCHEMA: jobs\[0\]\.energy/);
});

test('UNSAT input: certificate printed, status stays UNSAT (not UNKNOWN)', () => {
  const raw = makeInstance(5, 6);
  raw.energyBudget = 1;
  const r = invoke([tempJson(raw)]);
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.status, 'UNSAT');
  assert.equal(out.certificate.type, 'MINIMAL_INFEASIBLE_CORE');
  assert.equal(out.certificate.minimal, true);
});

test('--max-states 1: status UNKNOWN, never collapsed to UNSAT', () => {
  const r = invoke([tempJson(makeInstance(42, 12)), '--max-states', '1']);
  assert.equal(r.code, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.status, 'UNKNOWN');
  assert.ok(!('certificate' in out), 'UNKNOWN must not carry an UNSAT certificate');
});
