'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {
  StaticError,
  checkScript,
  parseObservations,
  observationsToJson,
} = require('../src/types');
const { compile, dump } = require('../src/compiler');
const { runProgram } = require('../src/vm');
const { run: runCli, EXIT_CRASH } = require('../src/cli');

const EXAMPLE_SCRIPT = path.join(__dirname, '..', 'examples', 'experiment.json');
const EXAMPLE_OBS = path.join(__dirname, '..', 'examples', 'obs.json');

function int(v) { return { kind: 'int', value: v }; }
function float(v) { return { kind: 'float', value: v }; }
function ev(v) { return { kind: 'evidence', value: v }; }
function obs(name) { return { kind: 'obs', name }; }
function bin(op, left, right) { return { kind: 'bin', op, left, right }; }
function assign(name, expr) { return { kind: 'assign', name, expr }; }
function guard(expr) { return { kind: 'guard', expr }; }
function txn(seq, body) { return { kind: 'txn', seq, body }; }
function block(name, body) { return { kind: 'block', name, body }; }

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-guard-'));
}

// Acceptance 1: two normal transactions produce the hand-computed result.
test('two normal transactions produce hand-computed result', () => {
  const base = parseObservations({ x: 1, y: 2.5, flag: true, sample: { $evidence: 'A' } });
  const script = block('root', [
    txn(1, [
      assign('x', bin('+', obs('x'), int(3))),       // x = 1 + 3 = 4
      assign('y', bin('*', obs('y'), float(2.0))),   // y = 2.5 * 2.0 = 5.0
      guard(bin('>=', obs('x'), int(4))),
    ]),
    block('inner', [
      txn(2, [
        assign('x', bin('*', obs('x'), int(2))),     // x = 4 * 2 = 8
        assign('sample', ev('B')),
        guard(bin('==', obs('sample'), ev('B'))),
      ]),
    ]),
  ]);
  checkScript(script, base.types);
  const result = runProgram(compile(script), base.registers, base.types, {
    committedSeqs: new Set(),
  });
  assert.deepEqual(result.rolledBack, []);
  assert.deepEqual(result.committed, [1, 2]);
  assert.deepEqual(observationsToJson(base.registers), {
    x: 8,
    y: 5.0,
    flag: true,
    sample: { $evidence: 'B' },
  });
});

// Acceptance 2: when the second transaction's guard fails, the first
// transaction stays committed and the second leaves no trace.
test('failed guard rolls back its whole transaction, earlier commits stay', () => {
  const base = parseObservations({ x: 5, y: 1 });
  const script = block('root', [
    txn(1, [assign('x', bin('+', obs('x'), int(5)))]), // x = 10, commits
    txn(2, [
      assign('x', int(99)),
      assign('y', int(7)),
      guard(bin('<', obs('x'), int(0))), // 99 < 0 is false -> abort
    ]),
    txn(3, [assign('y', bin('+', obs('y'), int(1)))]), // y = 1 + 1 = 2
  ]);
  checkScript(script, base.types);
  const result = runProgram(compile(script), base.registers, base.types, {
    committedSeqs: new Set(),
  });
  assert.deepEqual(result.committed, [1, 3]);
  assert.deepEqual(result.rolledBack, [{ seq: 2, reason: 'guard failed' }]);
  assert.deepEqual(observationsToJson(base.registers), { x: 10, y: 2 });
});

test('division by zero rolls back its whole transaction', () => {
  const base = parseObservations({ x: 5 });
  const script = block('root', [
    txn(1, [assign('x', bin('+', obs('x'), int(5)))]), // x = 10, commits
    txn(2, [
      assign('x', int(99)),
      assign('x', bin('/', obs('x'), int(0))), // division by zero -> abort
    ]),
  ]);
  checkScript(script, base.types);
  const result = runProgram(compile(script), base.registers, base.types, {
    committedSeqs: new Set(),
  });
  assert.deepEqual(result.committed, [1]);
  assert.deepEqual(result.rolledBack, [{ seq: 2, reason: 'division by zero' }]);
  assert.deepEqual(observationsToJson(base.registers), { x: 10 });
});

// Static type checking: guards must be bool, evidence fields bind only evidence.
test('static type errors are rejected before compilation', () => {
  const base = parseObservations({ x: 1, sample: { $evidence: 'A' } });
  assert.throws(
    () => checkScript(block('r', [txn(1, [guard(obs('x'))])]), base.types),
    /guard must be bool, got int/
  );
  assert.throws(
    () => checkScript(block('r', [txn(1, [assign('sample', int(3))])]), base.types),
    /evidence field sample can only bind evidence, got int/
  );
  assert.throws(
    () => checkScript(block('r', [txn(1, [assign('nope', int(3))])]), base.types),
    /unknown observation field: nope/
  );
  assert.throws(
    () =>
      checkScript(
        block('r', [txn(1, [assign('x', bin('%', obs('x'), float(1.5)))])]),
        base.types
      ),
    /operator % expects int operands/
  );
  assert.throws(
    () => checkScript(block('r', [txn(1, [guard(bin('==', obs('x'), ev('A')))])]), base.types),
    /operator == cannot compare int with evidence/
  );
});

// The instruction listing of the example script, enumerated by hand.
const EXPECTED_DUMP = [
  '0000 TXN_BEGIN 1',
  '0001 LOAD "x"',
  '0002 PUSH_INT 1',
  '0003 ADD',
  '0004 STORE "x"',
  '0005 LOAD "x"',
  '0006 PUSH_INT 0',
  '0007 GT',
  '0008 GUARD',
  '0009 TXN_COMMIT 1',
  '0010 TXN_BEGIN 2',
  '0011 LOAD "y"',
  '0012 PUSH_INT 5',
  '0013 ADD',
  '0014 STORE "y"',
  '0015 LOAD "x"',
  '0016 PUSH_INT 10',
  '0017 MUL',
  '0018 STORE "x"',
  '0019 PUSH_EV "B"',
  '0020 STORE "sample"',
  '0021 LOAD "y"',
  '0022 PUSH_INT 15',
  '0023 GE',
  '0024 GUARD',
  '0025 TXN_COMMIT 2',
  '0026 TXN_BEGIN 3',
  '0027 LOAD "y"',
  '0028 PUSH_INT 1',
  '0029 SUB',
  '0030 STORE "y"',
  '0031 TXN_COMMIT 3',
].join('\n');

test('--dump listing matches manual enumeration', () => {
  const script = JSON.parse(fs.readFileSync(EXAMPLE_SCRIPT, 'utf8'));
  assert.equal(dump(compile(script)), EXPECTED_DUMP);

  const dir = tmpdir();
  const state = path.join(dir, 'state.json');
  const run = runCli(['--script', EXAMPLE_SCRIPT, '--obs', EXAMPLE_OBS, '--state', state, '--dump']);
  assert.equal(run.code, 0, run.stderr);
  assert.equal(run.stderr.trim(), EXPECTED_DUMP);
});

// Acceptance 3: crash after the 16th instruction (mid transaction 2, before
// its commit), then rerun without --crash; the result must equal a single
// uninterrupted run, and the uncommitted transaction must not half-apply.
test('crash recovery: rerun after --crash matches a clean run', () => {
  const dir = tmpdir();
  const crashState = path.join(dir, 'crash.state.json');
  const cleanState = path.join(dir, 'clean.state.json');

  // Instruction 16 (1-based) is index 15: LOAD "x" inside transaction 2,
  // after STORE "y" but before TXN_COMMIT 2.
  const crashed = runCli([
    '--script', EXAMPLE_SCRIPT,
    '--obs', EXAMPLE_OBS,
    '--state', crashState,
    '--crash', '16',
  ]);
  assert.equal(crashed.code, EXIT_CRASH, crashed.stderr);
  assert.match(crashed.stderr, /crash: executed 16 instruction/);

  // Only transaction 1 may be committed; transaction 2's STORE "y" (y = 15)
  // must not be visible in the persisted state.
  const persisted = JSON.parse(fs.readFileSync(crashState, 'utf8'));
  assert.deepEqual(persisted.committed, [1]);
  assert.deepEqual(persisted.observations, {
    x: { t: 'int', v: 1 },
    y: { t: 'int', v: 10 },
    flag: { t: 'bool', v: true },
    sample: { t: 'evidence', v: 'A' },
  });

  // Rerun without --crash: resume from the state file.
  const resumed = runCli([
    '--script', EXAMPLE_SCRIPT,
    '--obs', EXAMPLE_OBS,
    '--state', crashState,
  ]);
  assert.equal(resumed.code, 0, resumed.stderr);
  const resumedOut = JSON.parse(resumed.stdout);
  assert.equal(resumedOut.ok, true);
  assert.equal(resumedOut.resumed, true);
  assert.deepEqual(resumedOut.committed, [1, 2, 3]);
  assert.deepEqual(resumedOut.rolledBack, []);

  // Clean single run with a fresh state file.
  const clean = runCli([
    '--script', EXAMPLE_SCRIPT,
    '--obs', EXAMPLE_OBS,
    '--state', cleanState,
  ]);
  assert.equal(clean.code, 0, clean.stderr);
  const cleanOut = JSON.parse(clean.stdout);

  // Hand-computed: txn1 x = 0 + 1 = 1; txn2 y = 10 + 5 = 15, x = 1 * 10 = 10,
  // sample = B, guard 15 >= 15 passes; txn3 y = 15 - 1 = 14.
  const expected = { x: 10, y: 14, flag: true, sample: { $evidence: 'B' } };
  assert.deepEqual(cleanOut.observations, expected);
  assert.deepEqual(resumedOut.observations, expected);
});

test('static type error via CLI yields empty result plus error', () => {
  const dir = tmpdir();
  const bad = path.join(dir, 'bad.json');
  fs.writeFileSync(
    bad,
    JSON.stringify(block('root', [txn(1, [assign('sample', int(3))])]))
  );
  const run = runCli([
    '--script', bad,
    '--obs', EXAMPLE_OBS,
    '--state', path.join(dir, 'state.json'),
  ]);
  assert.equal(run.code, 1);
  const out = JSON.parse(run.stdout);
  assert.equal(out.ok, false);
  assert.match(out.error, /evidence field sample can only bind evidence/);
  assert.deepEqual(out.observations, {});
});

test('StaticError is an Error subclass', () => {
  assert.ok(new StaticError('x') instanceof Error);
});
