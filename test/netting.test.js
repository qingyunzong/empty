'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  NettingError,
  hashInstruction,
  createState,
  addInstruction,
  cancelInstruction,
  mergeState,
  activeInstructions,
  computeNets,
  settle,
} = require('../src/netting');

const { run } = require('../cli');

function runCli(argv) {
  const result = run(argv);
  return {
    status: result.code,
    stdout: result.stdout.trim() ? JSON.parse(result.stdout) : null,
    stderr: result.stderr.trim() ? JSON.parse(result.stderr) : null,
  };
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'netting-'));
}

const INSTRUCTIONS = [
  { id: 'i1', payer: 'alice', payee: 'bob', amount: 100 },
  { id: 'i2', payer: 'bob', payee: 'carol', amount: 150 },
  { id: 'i3', payer: 'carol', payee: 'alice', amount: 200 },
];

function independentNets(instructions, cancelledIds) {
  const nets = {};
  for (const instruction of instructions) {
    if (cancelledIds.has(instruction.id)) continue;
    nets[instruction.payer] = (nets[instruction.payer] || 0) + instruction.amount;
    nets[instruction.payee] = (nets[instruction.payee] || 0) - instruction.amount;
  }
  return nets;
}

test('enumerates three instructions and all cancel subsets, cross-checking nets and certificates', () => {
  const budgets = { alice: 250, bob: 250, carol: 250 };
  const subsetCount = 1 << INSTRUCTIONS.length;
  for (let mask = 0; mask < subsetCount; mask += 1) {
    const cancelledIds = new Set(
      INSTRUCTIONS.filter((_, bit) => mask & (1 << bit)).map((instruction) => instruction.id),
    );

    const state = createState();
    for (const instruction of INSTRUCTIONS) addInstruction(state, instruction);
    for (const id of cancelledIds) cancelInstruction(state, id);

    const expectedNets = independentNets(INSTRUCTIONS, cancelledIds);
    assert.deepEqual(computeNets(state), expectedNets, `nets mismatch for mask ${mask}`);

    const certificate = settle(state, budgets);
    const expectedActive = INSTRUCTIONS.filter((instruction) => !cancelledIds.has(instruction.id));
    assert.deepEqual(
      certificate.instructions.map((instruction) => instruction.id),
      expectedActive.map((instruction) => instruction.id),
      `active set mismatch for mask ${mask}`,
    );
    assert.deepEqual(certificate.nets, expectedNets, `certificate nets mismatch for mask ${mask}`);

    const expectedBlocked = Object.entries(expectedNets).some(
      ([party, net]) => net > budgets[party],
    );
    assert.equal(certificate.status, expectedBlocked ? 'blocked' : 'settled');
    assert.equal(certificate.settled, !expectedBlocked);
    for (const [party, result] of Object.entries(certificate.budgets)) {
      assert.equal(result.net, expectedNets[party] || 0);
      assert.equal(result.withinBudget, result.net <= budgets[party]);
    }
  }
});

test('concurrent duplicate cancels take effect only once', () => {
  const state = createState();
  addInstruction(state, INSTRUCTIONS[0]);
  const hash = hashInstruction(INSTRUCTIONS[0]);
  const first = cancelInstruction(state, 'i1', hash);
  const second = cancelInstruction(state, 'i1', hash);
  assert.equal(first.applied, true);
  assert.equal(second.applied, false);
  assert.equal(state.cancels.length, 1);
  assert.deepEqual(second.tombstone, first.tombstone);
});

test('cancelling an unknown instruction is rejected', () => {
  const state = createState();
  assert.throws(() => cancelInstruction(state, 'nope'), (error) => {
    assert.ok(error instanceof NettingError);
    assert.equal(error.code, 'unknown-instruction');
    return true;
  });
});

test('cancel with mismatched observed hash is rejected', () => {
  const state = createState();
  addInstruction(state, INSTRUCTIONS[0]);
  assert.throws(() => cancelInstruction(state, 'i1', 'deadbeef'), { code: 'hash-mismatch' });
});

test('merge unions instructions and generates tombstones from remote cancels', () => {
  const replicaA = createState();
  addInstruction(replicaA, INSTRUCTIONS[0]);
  addInstruction(replicaA, INSTRUCTIONS[1]);

  const replicaB = createState();
  addInstruction(replicaB, INSTRUCTIONS[1]);
  addInstruction(replicaB, INSTRUCTIONS[2]);
  cancelInstruction(replicaB, 'i2');

  const { tombstones } = mergeState(replicaA, replicaB);
  assert.deepEqual(tombstones, [{ id: 'i2', hash: hashInstruction(INSTRUCTIONS[1]) }]);
  assert.deepEqual(
    activeInstructions(replicaA).map((instruction) => instruction.id),
    ['i1', 'i3'],
  );
  assert.deepEqual(computeNets(replicaA), independentNets(INSTRUCTIONS, new Set(['i2'])));
});

test('merge rejects cancels for unknown instructions', () => {
  const state = createState();
  assert.throws(
    () => mergeState(state, { instructions: [], cancels: [{ id: 'ghost', hash: 'x' }] }),
    { code: 'unknown-instruction' },
  );
});

test('conflicting instruction ids are rejected', () => {
  const state = createState();
  addInstruction(state, INSTRUCTIONS[0]);
  assert.throws(
    () => addInstruction(state, { id: 'i1', payer: 'alice', payee: 'bob', amount: 999 }),
    { code: 'conflicting-instruction' },
  );
  const again = addInstruction(state, INSTRUCTIONS[0]);
  assert.equal(again.added, false);
});

test('cli: three-party netting and settlement certificate', () => {
  const dir = tempDir();
  const state = path.join(dir, 'state.json');
  for (const instruction of INSTRUCTIONS) {
    const result = runCli([
      'instruct', '--state', state,
      '--id', instruction.id,
      '--payer', instruction.payer,
      '--payee', instruction.payee,
      '--amount', String(instruction.amount),
    ]);
    assert.equal(result.status, 0);
    assert.equal(result.stdout.hash, hashInstruction(instruction));
  }

  const net = runCli(['net', '--state', state]);
  assert.equal(net.status, 0);
  assert.deepEqual(net.stdout.nets, { alice: -100, bob: 50, carol: 50 });

  const settled = runCli(['settle', '--state', state, '--budgets', JSON.stringify({ alice: 100, bob: 100, carol: 100 })]);
  assert.equal(settled.status, 0);
  assert.equal(settled.stdout.status, 'settled');
  assert.equal(settled.stdout.settled, true);
  assert.deepEqual(settled.stdout.nets, { alice: -100, bob: 50, carol: 50 });
  assert.deepEqual(
    settled.stdout.instructions.map((instruction) => instruction.id),
    ['i1', 'i2', 'i3'],
  );
  assert.equal(settled.stdout.budgets.carol.withinBudget, true);
});

test('cli: cancelling the over-budget instruction unblocks settlement', () => {
  const dir = tempDir();
  const state = path.join(dir, 'state.json');
  for (const instruction of INSTRUCTIONS) {
    assert.equal(runCli([
      'instruct', '--state', state,
      '--id', instruction.id,
      '--payer', instruction.payer,
      '--payee', instruction.payee,
      '--amount', String(instruction.amount),
    ]).status, 0);
  }

  const budgets = JSON.stringify({ alice: 100, bob: 100, carol: 40 });
  const blocked = runCli(['settle', '--state', state, '--budgets', budgets]);
  assert.equal(blocked.status, 1);
  assert.deepEqual(blocked.stderr, { error: 'budget-exceeded' });
  assert.equal(blocked.stdout.status, 'blocked');
  assert.equal(blocked.stdout.settled, false);
  assert.equal(blocked.stdout.budgets.carol.withinBudget, false);

  const hash = hashInstruction(INSTRUCTIONS[2]);
  const cancelled = runCli(['cancel', '--state', state, '--id', 'i3', '--hash', hash]);
  assert.equal(cancelled.status, 0);
  assert.equal(cancelled.stdout.applied, true);
  assert.deepEqual(cancelled.stdout.tombstone, { id: 'i3', hash });

  const settled = runCli(['settle', '--state', state, '--budgets', budgets]);
  assert.equal(settled.status, 0);
  assert.equal(settled.stdout.status, 'settled');
  assert.deepEqual(settled.stdout.nets, { alice: 100, bob: 50, carol: -150 });
  assert.deepEqual(
    settled.stdout.instructions.map((instruction) => instruction.id),
    ['i1', 'i2'],
  );
});

test('cli: duplicate cancel is idempotent and unknown cancel fails', () => {
  const dir = tempDir();
  const state = path.join(dir, 'state.json');
  runCli(['instruct', '--state', state, '--id', 'i1', '--payer', 'alice', '--payee', 'bob', '--amount', '100']);

  const first = runCli(['cancel', '--state', state, '--id', 'i1']);
  assert.equal(first.status, 0);
  assert.equal(first.stdout.applied, true);

  const second = runCli(['cancel', '--state', state, '--id', 'i1']);
  assert.equal(second.status, 0);
  assert.equal(second.stdout.applied, false);
  assert.deepEqual(second.stdout.tombstone, first.stdout.tombstone);

  const unknown = runCli(['cancel', '--state', state, '--id', 'ghost']);
  assert.equal(unknown.status, 1);
  assert.deepEqual(unknown.stderr, { error: 'unknown-instruction' });
});

test('cli: merge imports instructions and tombstones from another replica', () => {
  const dir = tempDir();
  const stateA = path.join(dir, 'a.json');
  const stateB = path.join(dir, 'b.json');

  runCli(['instruct', '--state', stateA, '--id', 'i1', '--payer', 'alice', '--payee', 'bob', '--amount', '100']);
  runCli(['instruct', '--state', stateB, '--id', 'i2', '--payer', 'bob', '--payee', 'carol', '--amount', '150']);
  runCli(['cancel', '--state', stateB, '--id', 'i2']);

  const merged = runCli(['merge', '--state', stateA, stateB]);
  assert.equal(merged.status, 0);
  assert.equal(merged.stdout.merged, true);
  assert.equal(merged.stdout.tombstones.length, 1);
  assert.equal(merged.stdout.tombstones[0].id, 'i2');

  const net = runCli(['net', '--state', stateA]);
  assert.deepEqual(net.stdout.nets, { alice: 100, bob: -100 });
});
