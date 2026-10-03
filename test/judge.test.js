'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { EXIT, JudgeError } = require('../src/model');
const { judgeText, judgeCommands } = require('../src/judge');
const { findSchedule, findMinimalConflict } = require('../src/solver');
const { bruteForceSchedule, isValidPermutation } = require('../src/brute');

const ROOT = path.join(__dirname, '..');

function cmd(opId, overrides = {}) {
  return {
    opId,
    session: `s-${opId}`,
    start: 0,
    end: 10,
    action: 'DEBIT',
    account: 'A',
    amount: 0,
    depends: [],
    ...overrides,
  };
}

// --- SAT / witness ---------------------------------------------------------

test('serializable freeze/debit interleaving returns a witness', () => {
  const result = judgeText(`{"type":"init","balances":{"accA":100,"accB":50}}
{"opId":"c1","session":"s1","start":1,"end":4,"action":"FREEZE","account":"accA","amount":30,"depends":[]}
{"opId":"c2","session":"s2","start":2,"end":5,"action":"FREEZE","account":"accB","amount":20,"depends":[]}
{"opId":"c3","session":"s1","start":3,"end":6,"action":"SETTLE","account":"accA","amount":30,"depends":["c1"]}
{"opId":"c4","session":"s2","start":4,"end":7,"action":"RELEASE","account":"accB","amount":20,"depends":["c2"]}
{"opId":"c5","session":null,"start":5,"end":8,"action":"DEBIT","account":"accA","amount":60,"depends":[]}
`);
  assert.equal(result.verdict, 'SAT');
  const byId = new Map([
    ['c1', 0], ['c2', 1], ['c3', 2], ['c4', 3], ['c5', 4],
  ]);
  assert.ok(result.witness.indexOf('c1') < result.witness.indexOf('c3'));
  assert.ok(result.witness.indexOf('c2') < result.witness.indexOf('c4'));
  assert.deepEqual([...result.witness].sort(), [...byId.keys()]);
});

test('lexicographically smallest witness is chosen among ties', () => {
  // Three independent zero-amount debits: every permutation is valid.
  const commands = [cmd('c3'), cmd('c1'), cmd('c2')];
  const result = judgeCommands(commands, { A: 10 });
  assert.equal(result.verdict, 'SAT');
  assert.deepEqual(result.witness, ['c1', 'c2', 'c3']);
});

test('interval order constrains the witness', () => {
  // b must follow a (a.end <= b.start) even though "a" > "b" would not
  // be an issue here; use reversed ids to prove the constraint wins.
  const commands = [
    cmd('z', { start: 0, end: 1 }),
    cmd('a', { start: 2, end: 3 }),
  ];
  const result = judgeCommands(commands, { A: 10 });
  assert.deepEqual(result.witness, ['z', 'a']);
});

// --- UNSAT / conflict subsets ----------------------------------------------

test('over-freezing makes DEBIT fail: UNSAT with minimal conflict', () => {
  const result = judgeText(`{"type":"init","balances":{"A":40}}
{"opId":"c1","session":"s1","start":1,"end":3,"action":"FREEZE","account":"A","amount":25,"depends":[]}
{"opId":"c2","session":null,"start":2,"end":4,"action":"DEBIT","account":"A","amount":20,"depends":[]}
`);
  assert.equal(result.verdict, 'UNSAT');
  assert.deepEqual(result.conflict, ['c1', 'c2']);
});

test('negative available balance is reported as UNSAT, not an error', () => {
  const result = judgeCommands(
    [cmd('d1', { amount: 50 }), cmd('d2', { amount: 60 })],
    { A: 100 },
  );
  assert.equal(result.verdict, 'UNSAT');
  assert.deepEqual(result.conflict, ['d1', 'd2']);
});

test('SETTLE without a prior FREEZE is UNSAT', () => {
  const result = judgeCommands(
    [cmd('s1', { action: 'SETTLE', session: 'sx', amount: 5 })],
    { A: 100 },
  );
  assert.equal(result.verdict, 'UNSAT');
  assert.deepEqual(result.conflict, ['s1']);
});

test('RELEASE exceeding the frozen amount is UNSAT', () => {
  const result = judgeCommands(
    [
      cmd('f1', { action: 'FREEZE', session: 'sx', amount: 10 }),
      cmd('r1', { action: 'RELEASE', session: 'sx', amount: 20 }),
    ],
    { A: 100 },
  );
  assert.equal(result.verdict, 'UNSAT');
  // A lone RELEASE of 20 with an empty frozen pool is already UNSAT,
  // so the minimum conflict is the single RELEASE command.
  assert.deepEqual(result.conflict, ['r1']);
});

test('conflict subset is minimal and lexicographically determined', () => {
  // Two independent UNSAT pairs: {c1,c2} and {c3,c4}; the minimum
  // conflict is the lexicographically smaller one.
  const commands = [
    cmd('c1', { action: 'FREEZE', session: 's1', amount: 25 }),
    cmd('c2', { action: 'DEBIT', amount: 20 }),
    cmd('c3', { action: 'FREEZE', session: 's2', amount: 25 }),
    cmd('c4', { action: 'DEBIT', amount: 20 }),
  ];
  const conflict = findMinimalConflict(commands, { A: 40 });
  assert.deepEqual(conflict, ['c1', 'c2']);
});

// --- error exits -----------------------------------------------------------

test('invalid interval is reported with exit code 12', () => {
  assert.throws(
    () => judgeCommands([cmd('x', { start: 5, end: 2 })]),
    (err) => err instanceof JudgeError && err.code === EXIT.INVALID_INTERVAL,
  );
});

test('depends cycle is reported with exit code 13', () => {
  assert.throws(
    () => judgeCommands([cmd('a', { depends: ['b'] }), cmd('b', { depends: ['a'] })]),
    (err) => err instanceof JudgeError && err.code === EXIT.DEPENDS_CYCLE,
  );
});

test('depends cycle and negative balance are reported separately', () => {
  // Cycle: hard error 13 even though balances would also go negative.
  assert.throws(
    () => judgeCommands(
      [cmd('a', { amount: 999, depends: ['b'] }), cmd('b', { amount: 999, depends: ['a'] })],
      { A: 0 },
    ),
    (err) => err.code === EXIT.DEPENDS_CYCLE,
  );
  // No cycle, negative balance: ordinary UNSAT verdict.
  const result = judgeCommands([cmd('a', { amount: 5 })], { A: 0 });
  assert.equal(result.verdict, 'UNSAT');
});

test('unknown action is reported with exit code 14', () => {
  assert.throws(
    () => judgeCommands([cmd('x', { action: 'REFUND' })]),
    (err) => err instanceof JudgeError && err.code === EXIT.UNKNOWN_COMMAND,
  );
});

test('depends on an unknown command is reported with exit code 14', () => {
  assert.throws(
    () => judgeCommands([cmd('x', { depends: ['ghost'] })]),
    (err) => err instanceof JudgeError && err.code === EXIT.UNKNOWN_COMMAND,
  );
});

// --- CLI -------------------------------------------------------------------

// Runs the CLI in a subprocess. stdout/stderr are captured via temp
// files because piping grandchild stdio is unreliable in some sandboxes.
function runCli(args, dir) {
  const outFile = path.join(dir, 'stdout.txt');
  const errFile = path.join(dir, 'stderr.txt');
  const quoted = [path.join(ROOT, 'judge'), ...args]
    .map((a) => `'${String(a).replace(/'/g, `'\\''`)}'`)
    .join(' ');
  const run = spawnSync(
    'bash',
    ['-c', `${process.execPath} ${quoted} > '${outFile}' 2> '${errFile}'`],
    { encoding: 'utf8' },
  );
  assert.equal(run.status, 0, `shell wrapper failed: ${run.stderr}`);
  return {
    stdout: fs.readFileSync(outFile, 'utf8'),
    stderr: fs.readFileSync(errFile, 'utf8'),
  };
}

// Runs the CLI and returns { status, stdout, stderr }.
function runCliStatus(args, dir) {
  const rcFile = path.join(dir, 'rc.txt');
  const quoted = [path.join(ROOT, 'judge'), ...args]
    .map((a) => `'${String(a).replace(/'/g, `'\\''`)}'`)
    .join(' ');
  const outFile = path.join(dir, 'stdout.txt');
  const errFile = path.join(dir, 'stderr.txt');
  const run = spawnSync(
    'bash',
    ['-c', `${process.execPath} ${quoted} > '${outFile}' 2> '${errFile}'; echo $? > '${rcFile}'`],
    { encoding: 'utf8' },
  );
  assert.equal(run.status, 0, `shell wrapper failed: ${run.stderr}`);
  return {
    status: Number(fs.readFileSync(rcFile, 'utf8').trim()),
    stdout: fs.readFileSync(outFile, 'utf8'),
    stderr: fs.readFileSync(errFile, 'utf8'),
  };
}

function withTempHistory(text, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'judge-test-'));
  const file = path.join(dir, 'history.jsonl');
  fs.writeFileSync(file, text);
  try {
    return fn(file, dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('CLI prints SAT witness and writes --explain JSON', () => {
  const out = withTempHistory(
    `{"type":"init","balances":{"A":10}}\n{"opId":"a","session":"s","start":0,"end":1,"action":"DEBIT","account":"A","amount":5,"depends":[]}\n`,
    (file, dir) => {
      const explain = path.join(dir, 'out.json');
      const run = runCliStatus([file, '--explain', explain], dir);
      assert.equal(run.status, 0, run.stderr);
      assert.match(run.stdout, /^SAT\nwitness: a\n/);
      assert.deepEqual(JSON.parse(fs.readFileSync(explain, 'utf8')), {
        verdict: 'SAT',
        witness: ['a'],
      });
    },
  );
  return out;
});

test('CLI exit codes: 12 invalid interval, 13 cycle, 14 unknown', () => {
  const cases = [
    ['{"opId":"a","session":"s","start":3,"end":1,"action":"DEBIT","account":"A","amount":1}\n', 12],
    [
      '{"opId":"a","session":"s","start":0,"end":1,"action":"DEBIT","account":"A","amount":1,"depends":["b"]}\n' +
        '{"opId":"b","session":"s","start":0,"end":1,"action":"DEBIT","account":"A","amount":1,"depends":["a"]}\n',
      13,
    ],
    ['{"opId":"a","session":"s","start":0,"end":1,"action":"DEBIT","account":"A","amount":1,"depends":["zz"]}\n', 14],
  ];
  for (const [text, code] of cases) {
    withTempHistory(text, (file, dir) => {
      const run = runCliStatus([file], dir);
      assert.equal(run.status, code, `want ${code}, stderr: ${run.stderr}`);
    });
  }
});

test('CLI UNSAT prints conflict subset', () => {
  withTempHistory(
    '{"opId":"a","session":"s","start":0,"end":1,"action":"DEBIT","account":"A","amount":5}\n',
    (file, dir) => {
      const run = runCliStatus([file], dir);
      assert.equal(run.status, 0, run.stderr);
      assert.match(run.stdout, /^UNSAT\nconflict: a\n/);
    },
  );
});

// --- brute-force cross-check (n <= 8) ---------------------------------------

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomInstance(rand, n) {
  const accounts = ['A', 'B'];
  const balances = { A: Math.floor(rand() * 9), B: Math.floor(rand() * 9) };
  const actions = ['FREEZE', 'DEBIT', 'RELEASE', 'SETTLE'];
  const commands = [];
  for (let i = 0; i < n; i += 1) {
    const start = Math.floor(rand() * 6);
    const depends = [];
    for (let j = 0; j < i; j += 1) {
      if (rand() < 0.15) depends.push(`op${j}`);
    }
    commands.push({
      opId: `op${i}`,
      session: `s${Math.floor(rand() * 3)}`,
      start,
      end: start + Math.floor(rand() * 4),
      action: actions[Math.floor(rand() * actions.length)],
      account: accounts[Math.floor(rand() * accounts.length)],
      amount: Math.floor(rand() * 6),
      depends,
    });
  }
  return { commands, balances };
}

test('solver matches brute-force permutation enumeration for n <= 8', () => {
  const rand = mulberry32(20261004);
  let satCount = 0;
  let unsatCount = 0;
  for (let trial = 0; trial < 200; trial += 1) {
    const n = 1 + Math.floor(rand() * 8);
    const { commands, balances } = randomInstance(rand, n);
    const expected = bruteForceSchedule(commands, balances);
    const actual = findSchedule(commands, balances);
    if (expected === null) {
      unsatCount += 1;
      assert.equal(actual, null, `trial ${trial}: solver SAT but brute force UNSAT`);
    } else {
      satCount += 1;
      assert.deepEqual(actual, expected, `trial ${trial}: witness mismatch`);
    }
  }
  assert.ok(satCount > 0 && unsatCount > 0, `want both verdicts covered (SAT=${satCount}, UNSAT=${unsatCount})`);
});

test('minimal conflict subsets verified against brute force for n <= 8', () => {
  const rand = mulberry32(11235813);
  let verified = 0;
  for (let trial = 0; trial < 400 && verified < 6; trial += 1) {
    const n = 5 + Math.floor(rand() * 4);
    const { commands, balances } = randomInstance(rand, n);
    if (bruteForceSchedule(commands, balances) !== null) continue;
    const conflict = findMinimalConflict(commands, balances);
    const byId = new Map(commands.map((c) => [c.opId, c]));
    // The conflict itself must be UNSAT by brute force.
    const subset = conflict.map((id) => byId.get(id));
    assert.equal(bruteForceSchedule(subset, balances), null, `trial ${trial}: conflict is SAT`);
    // Every proper sub-subset must be SAT by brute force (minimality).
    for (const drop of conflict) {
      const smaller = conflict.filter((id) => id !== drop).map((id) => byId.get(id));
      assert.notEqual(
        bruteForceSchedule(smaller, balances),
        null,
        `trial ${trial}: ${conflict} not minimal, ${drop} removable`,
      );
    }
    verified += 1;
  }
  assert.ok(verified > 0, 'no UNSAT random instance found to verify');
});

test('brute-force validity checker accepts solver witnesses', () => {
  const rand = mulberry32(777);
  for (let trial = 0; trial < 50; trial += 1) {
    const n = 1 + Math.floor(rand() * 8);
    const { commands, balances } = randomInstance(rand, n);
    const witness = findSchedule(commands, balances);
    if (witness === null) continue;
    const byId = new Map(commands.map((c) => [c.opId, c]));
    const permutation = witness.map((id) => byId.get(id));
    assert.ok(isValidPermutation(permutation, balances), `trial ${trial}: witness invalid`);
  }
});
