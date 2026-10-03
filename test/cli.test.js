'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const CLI = path.join(__dirname, '..', 'cli.js');

function run(files, args) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-cli-'));
  const paths = {};
  for (const [name, content] of Object.entries(files)) {
    paths[name] = path.join(dir, name);
    fs.writeFileSync(paths[name], content);
  }
  const argv = args.map((a) => paths[a] || a);
  const res = spawnSync(process.execPath, [CLI, ...argv], { encoding: 'utf8' });
  return res;
}

test('CLI classifies a plan and reports hash, ids and witness', () => {
  const res = run(
    {
      'rules.jsonl': [
        '{"op":"add","id":"r1","level":"red","pattern":"FF"}',
        '{"op":"add","id":"y1","level":"yellow","pattern":"SA"}',
        '',
      ].join('\n'),
      'plan.txt': 'SSAF\n',
    },
    ['rules.jsonl', 'plan.txt'],
  );
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.status, 'confirm');
  assert.deepEqual(out.matchedRuleIds, ['y1']);
  assert.equal(out.witness, 'SA');
  assert.match(out.snapshotHash, /^[0-9a-f]{64}$/);
});

test('CLI red priority with shortest counterexample', () => {
  const res = run(
    {
      'rules.jsonl': [
        '{"op":"add","id":"y1","level":"yellow","pattern":"B"}',
        '{"op":"add","id":"r1","level":"red","pattern":"ABA"}',
        '',
      ].join('\n'),
      'plan.txt': 'ABAB',
    },
    ['rules.jsonl', 'plan.txt'],
  );
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.status, 'reject');
  assert.deepEqual(out.matchedRuleIds, ['r1']);
  assert.equal(out.witness, 'ABA');
});

test('CLI: regex syntax error exits 2 and reports line:column', () => {
  const res = run(
    {
      'rules.jsonl': [
        '{"op":"add","id":"ok","level":"red","pattern":"AB"}',
        '{"op":"add","id":"bad","level":"red","pattern":"A(B"}',
        '',
      ].join('\n'),
      'plan.txt': 'AB',
    },
    ['rules.jsonl', 'plan.txt'],
  );
  assert.equal(res.status, 2);
  assert.equal(res.stdout, '');
  assert.match(res.stderr, /rules\.jsonl:2:4: regex syntax error/);
});

test('CLI: unknown rule id exits 2 and reports the line', () => {
  const res = run(
    {
      'rules.jsonl': [
        '{"op":"add","id":"r1","level":"red","pattern":"AB"}',
        '{"op":"del","id":"nope"}',
        '',
      ].join('\n'),
      'plan.txt': 'AB',
    },
    ['rules.jsonl', 'plan.txt'],
  );
  assert.equal(res.status, 2);
  assert.match(res.stderr, /rules\.jsonl:2: unknown rule id: nope/);
});

test('CLI: undo out of range exits 2 and reports the line', () => {
  const res = run(
    {
      'rules.jsonl': [
        '{"op":"add","id":"r1","level":"red","pattern":"AB"}',
        '{"op":"add","id":"r2","level":"red","pattern":"BA"}',
        '{"op":"undo","k":3}',
        '',
      ].join('\n'),
      'plan.txt': 'AB',
    },
    ['rules.jsonl', 'plan.txt'],
  );
  assert.equal(res.status, 2);
  assert.match(res.stderr, /rules\.jsonl:3: undo out of range: requested 3, depth 2/);
});

test('CLI: empty alphabet and empty plan are legal', () => {
  const res = run(
    { 'rules.jsonl': '', 'plan.txt': '' },
    ['rules.jsonl', 'plan.txt'],
  );
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.status, 'feasible');
  assert.deepEqual(out.matchedRuleIds, []);
  assert.equal(out.witness, null);
  assert.match(out.snapshotHash, /^[0-9a-f]{64}$/);
});

test('CLI: epsilon-only rule matches even the empty plan', () => {
  const res = run(
    {
      'rules.jsonl': '{"op":"add","id":"e","level":"red","pattern":""}\n',
      'plan.txt': '',
    },
    ['rules.jsonl', 'plan.txt'],
  );
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.status, 'reject');
  assert.deepEqual(out.matchedRuleIds, ['e']);
  assert.equal(out.witness, '');
});

test('CLI: undo/redo interleaved log matches a fresh replay of the effective log', () => {
  const res = run(
    {
      'rules.jsonl': [
        '{"op":"add","id":"r1","level":"red","pattern":"AB"}',
        '{"op":"add","id":"y1","level":"yellow","pattern":"S"}',
        '{"op":"add","id":"r2","level":"red","pattern":"FF"}',
        '{"op":"undo"}',
        '{"op":"add","id":"r3","level":"red","pattern":"BA"}',
        '{"op":"del","id":"r1"}',
        '{"op":"undo","k":2}',
        '{"op":"redo"}',
        '',
      ].join('\n'),
      'plan.txt': 'BA',
    },
    ['rules.jsonl', 'plan.txt'],
  );
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);

  // Effective log after collapsing undo/redo: add r1, add y1, del r1.
  const replay = run(
    {
      'rules.jsonl': [
        '{"op":"add","id":"r1","level":"red","pattern":"AB"}',
        '{"op":"add","id":"y1","level":"yellow","pattern":"S"}',
        '{"op":"del","id":"r1"}',
        '',
      ].join('\n'),
      'plan.txt': 'BA',
    },
    ['rules.jsonl', 'plan.txt'],
  );
  assert.equal(replay.status, 0, replay.stderr);
  assert.deepEqual(out, JSON.parse(replay.stdout));
});

test('CLI: --equiv reports empty witness and equal hashes for equivalent rewrites', () => {
  const files = {
    'a.jsonl': [
      '{"op":"add","id":"r1","level":"red","pattern":"A(B|C)"}',
      '{"op":"add","id":"y1","level":"yellow","pattern":"(S*)*"}',
      '',
    ].join('\n'),
    'b.jsonl': [
      '{"op":"add","id":"x1","level":"red","pattern":"AB|AC"}',
      '{"op":"add","id":"x2","level":"yellow","pattern":"S*"}',
      '',
    ].join('\n'),
    'plan.txt': 'AB',
  };
  const res = run(files, ['a.jsonl', 'plan.txt', '--equiv', 'b.jsonl']);
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.deepEqual(out.equivalence, { equal: true, level: null, witness: null });

  const resB = run(files, ['b.jsonl', 'plan.txt']);
  assert.equal(JSON.parse(resB.stdout).snapshotHash, out.snapshotHash);
});

test('CLI: --equiv reports the shortest distinguishing witness when different', () => {
  const files = {
    'a.jsonl': '{"op":"add","id":"r1","level":"red","pattern":"AB"}\n',
    'b.jsonl': '{"op":"add","id":"r1","level":"red","pattern":"AB|BA"}\n',
    'plan.txt': 'ZZ',
  };
  const res = run(files, ['a.jsonl', 'plan.txt', '--equiv', 'b.jsonl']);
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.equivalence.equal, false);
  assert.equal(out.equivalence.level, 'red');
  assert.equal(out.equivalence.witness, 'BA');
});
