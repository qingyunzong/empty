import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run, CRASH_EXIT_CODE } from '../src/cli.js';

function setup(script) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-guard-'));
  const scriptPath = path.join(dir, 'script.json');
  const statePath = path.join(dir, 'state.json');
  fs.writeFileSync(scriptPath, JSON.stringify(script));
  return { dir, scriptPath, statePath };
}

function cli(scriptPath, statePath, extra = []) {
  return run(['--script', scriptPath, '--state', statePath, ...extra]);
}

function parseStdout(result) {
  return JSON.parse(result.stdout.trim());
}

// Acceptance 1: two normal transactions produce hand-computed results.
test('two committed transactions yield hand-computed observations', () => {
  const script = {
    observations: {
      a: { type: 'int', value: 1 },
      b: { type: 'int', value: 10 },
      f: { type: 'float', value: 2.5 },
      ok: { type: 'bool', value: false },
      ev: { type: 'evidence', value: 'init' },
    },
    transactions: [
      {
        name: 'tx1',
        body: [
          // a = 1 + 4 = 5
          { assign: 'a', expr: { op: '+', left: { var: 'a' }, right: { lit: 4 } } },
          // b = 10 * 5 = 50
          { assign: 'b', expr: { op: '*', left: { var: 'b' }, right: { var: 'a' } } },
          // f = 2.5 / 2.5 = 1.0
          { assign: 'f', expr: { op: '/', left: { var: 'f' }, right: { lit: 2.5 } } },
          // ok = 5 > 3 = true
          { assign: 'ok', expr: { op: '>', left: { var: 'a' }, right: { lit: 3 } } },
          { guard: { var: 'ok' } },
        ],
      },
      {
        name: 'tx2',
        body: [
          { guard: { op: '==', left: { var: 'a' }, right: { lit: 5 } } },
          // a = 5 / 2 = 2 (integer truncation)
          { assign: 'a', expr: { op: '/', left: { var: 'a' }, right: { lit: 2 } } },
          {
            block: 'inner',
            body: [
              // b = 50 - 42 = 8
              { assign: 'b', expr: { op: '-', left: { var: 'b' }, right: { lit: 42 } } },
              { assign: 'ev', expr: { lit: { evidence: 'final' } } },
            ],
          },
        ],
      },
    ],
  };
  const { scriptPath, statePath } = setup(script);
  const result = cli(scriptPath, statePath);
  assert.equal(result.code, 0);
  const out = parseStdout(result);
  assert.equal(out.ok, true);
  assert.deepEqual(out.observations, {
    a: { type: 'int', value: 2 },
    b: { type: 'int', value: 8 },
    f: { type: 'float', value: 1 },
    ok: { type: 'bool', value: true },
    ev: { type: 'evidence', value: 'final' },
  });
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  assert.equal(state.committed, 2);
});

// Acceptance 2: when the second transaction's guard fails, the first
// transaction stays committed and the second leaves no trace.
test('failed guard rolls back the whole second transaction only', () => {
  const script = {
    observations: {
      a: { type: 'int', value: 1 },
      b: { type: 'int', value: 2 },
    },
    transactions: [
      {
        name: 'tx1',
        body: [{ assign: 'a', expr: { op: '+', left: { var: 'a' }, right: { lit: 10 } } }],
      },
      {
        name: 'tx2',
        body: [
          { assign: 'b', expr: { lit: 99 } },
          { assign: 'a', expr: { lit: 77 } },
          { guard: { op: '>', left: { var: 'a' }, right: { lit: 1000 } } },
        ],
      },
    ],
  };
  const { scriptPath, statePath } = setup(script);
  const result = cli(scriptPath, statePath);
  assert.equal(result.code, 1);
  const out = parseStdout(result);
  assert.equal(out.ok, false);
  assert.match(out.error, /guard failed/);
  assert.match(out.error, /tx2/);
  assert.equal(out.observations, undefined);
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  assert.equal(state.committed, 1);
  assert.deepEqual(state.observations, {
    a: { type: 'int', value: 11 },
    b: { type: 'int', value: 2 },
  });
});

// Division by zero also rolls back the whole transaction.
test('division by zero rolls back the transaction', () => {
  const script = {
    observations: { x: { type: 'int', value: 0 } },
    transactions: [
      {
        name: 'tx1',
        body: [{ assign: 'x', expr: { op: '+', left: { lit: 2 }, right: { lit: 3 } } }],
      },
      {
        name: 'tx2',
        body: [
          { assign: 'x', expr: { lit: 99 } },
          { assign: 'x', expr: { op: '/', left: { lit: 1 }, right: { lit: 0 } } },
        ],
      },
    ],
  };
  const { scriptPath, statePath } = setup(script);
  const result = cli(scriptPath, statePath);
  assert.equal(result.code, 1);
  const out = parseStdout(result);
  assert.equal(out.ok, false);
  assert.match(out.error, /division by zero/);
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  assert.equal(state.committed, 1);
  assert.deepEqual(state.observations, { x: { type: 'int', value: 5 } });
});

// Acceptance 3: crash recovery. The instruction listing is enumerated by
// hand below and compared against --dump; a crash mid-transaction must not
// half-apply, and rerunning must match a clean run.
const crashScript = {
  observations: {
    x: { type: 'int', value: 0 },
    y: { type: 'int', value: 5 },
  },
  transactions: [
    {
      name: 'tx1',
      body: [
        { assign: 'x', expr: { op: '+', left: { var: 'x' }, right: { lit: 1 } } },
        { assign: 'y', expr: { op: '*', left: { var: 'y' }, right: { lit: 2 } } },
      ],
    },
    {
      name: 'tx2',
      body: [
        { guard: { op: '==', left: { var: 'y' }, right: { lit: 10 } } },
        { assign: 'x', expr: { op: '+', left: { var: 'x' }, right: { lit: 10 } } },
        { assign: 'y', expr: { op: '-', left: { var: 'y' }, right: { lit: 3 } } },
      ],
    },
    {
      name: 'tx3',
      body: [{ assign: 'x', expr: { op: '*', left: { var: 'x' }, right: { lit: 3 } } }],
    },
  ],
};

const EXPECTED_DUMP = [
  '0001 BEGIN_TX tx1',
  '0002 LOAD x',
  '0003 PUSH 1',
  '0004 ADD',
  '0005 STORE x',
  '0006 LOAD y',
  '0007 PUSH 2',
  '0008 MUL',
  '0009 STORE y',
  '0010 COMMIT tx1',
  '0011 BEGIN_TX tx2',
  '0012 LOAD y',
  '0013 PUSH 10',
  '0014 EQ',
  '0015 GUARD',
  '0016 LOAD x',
  '0017 PUSH 10',
  '0018 ADD',
  '0019 STORE x',
  '0020 LOAD y',
  '0021 PUSH 3',
  '0022 SUB',
  '0023 STORE y',
  '0024 COMMIT tx2',
  '0025 BEGIN_TX tx3',
  '0026 LOAD x',
  '0027 PUSH 3',
  '0028 MUL',
  '0029 STORE x',
  '0030 COMMIT tx3',
].join('\n');

test('--dump matches the hand-enumerated instruction listing', () => {
  const { scriptPath, statePath } = setup(crashScript);
  const result = cli(scriptPath, statePath, ['--dump']);
  assert.equal(result.code, 0);
  assert.equal(result.stdout.trim(), EXPECTED_DUMP);
  assert.equal(fs.existsSync(statePath), false, '--dump must not execute');
});

test('crash mid-transaction leaves no partial effects; rerun matches clean run', () => {
  // Clean reference run.
  const clean = setup(crashScript);
  const cleanResult = cli(clean.scriptPath, clean.statePath);
  assert.equal(cleanResult.code, 0);
  const cleanOut = parseStdout(cleanResult);
  assert.equal(cleanOut.ok, true);
  // Hand-computed: tx1 x=1 y=10; tx2 guard ok, x=11, y=7; tx3 x=33.
  assert.deepEqual(cleanOut.observations, {
    x: { type: 'int', value: 33 },
    y: { type: 'int', value: 7 },
  });

  // Crash after instruction 17 (PUSH 10 inside tx2, before its commit).
  const crashed = setup(crashScript);
  const crashResult = cli(crashed.scriptPath, crashed.statePath, ['--crash', '17']);
  assert.equal(crashResult.code, CRASH_EXIT_CODE);
  const stateAfterCrash = JSON.parse(fs.readFileSync(crashed.statePath, 'utf8'));
  assert.equal(stateAfterCrash.committed, 1);
  assert.deepEqual(stateAfterCrash.observations, {
    x: { type: 'int', value: 1 },
    y: { type: 'int', value: 10 },
  });

  // Rerun without --crash resumes after the committed transaction.
  const resumed = cli(crashed.scriptPath, crashed.statePath);
  assert.equal(resumed.code, 0);
  const resumedOut = parseStdout(resumed);
  assert.deepEqual(resumedOut, cleanOut);
  const finalState = JSON.parse(fs.readFileSync(crashed.statePath, 'utf8'));
  assert.equal(finalState.committed, 3);
});

// Static type checking: guards must be bool; evidence fields bind evidence only.
test('static type errors are rejected before execution', () => {
  const cases = [
    {
      name: 'non-bool guard',
      script: {
        observations: { a: { type: 'int', value: 1 } },
        transactions: [{ name: 'tx1', body: [{ guard: { var: 'a' } }] }],
      },
      pattern: /guard must be bool/,
    },
    {
      name: 'int bound to evidence field',
      script: {
        observations: { ev: { type: 'evidence', value: 'init' } },
        transactions: [{ name: 'tx1', body: [{ assign: 'ev', expr: { lit: 3 } }] }],
      },
      pattern: /cannot bind int to evidence/,
    },
    {
      name: 'evidence bound to int field',
      script: {
        observations: { a: { type: 'int', value: 1 } },
        transactions: [
          { name: 'tx1', body: [{ assign: 'a', expr: { lit: { evidence: 'x' } } }] },
        ],
      },
      pattern: /cannot bind evidence to int/,
    },
    {
      name: 'arithmetic on bool',
      script: {
        observations: { a: { type: 'int', value: 1 }, ok: { type: 'bool', value: true } },
        transactions: [
          {
            name: 'tx1',
            body: [{ assign: 'a', expr: { op: '+', left: { var: 'ok' }, right: { lit: 1 } } }],
          },
        ],
      },
      pattern: /expects numeric operands/,
    },
  ];
  for (const { name, script, pattern } of cases) {
    const { scriptPath, statePath } = setup(script);
    const result = cli(scriptPath, statePath);
    assert.equal(result.code, 1, name);
    const out = parseStdout(result);
    assert.equal(out.ok, false, name);
    assert.match(out.error, /type error/, name);
    assert.match(out.error, pattern, name);
    assert.equal(fs.existsSync(statePath), false, `${name}: no state may be written`);
  }
});
