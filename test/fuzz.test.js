import test from 'node:test';
import assert from 'node:assert/strict';
import { fuzzRun } from '../src/fuzz.js';
import { replayRun } from '../src/replay.js';
import { canonicalString } from '../src/hash.js';
import { enumerateFinalStates } from '../src/enumerator.js';

test('seed 42 run contains at least one cancel race and one business rejection', () => {
  const run = fuzzRun({ seed: 42, steps: 80, accounts: 3 });
  const cancelRaces = run.ops.filter(
    (op) => op.type === 'cancel' && op.result === 'rejected' && op.reason === 'RACE_ALREADY_SETTLED',
  );
  const businessRejections = run.ops.filter(
    (op) => op.result === 'rejected' && (op.reason === 'INSUFFICIENT_FUNDS' || op.reason === 'ACCOUNT_FROZEN'),
  );
  console.log(`seed=42 cancelAfterSettleRaces=${cancelRaces.length} businessRejections=${businessRejections.length}`);
  assert.ok(cancelRaces.length >= 1, 'expected at least one cancel-after-settle race');
  assert.ok(businessRejections.length >= 1, 'expected at least one business rejection');
});

test('log records seed, sequence, random samples, op id and result', () => {
  const run = fuzzRun({ seed: 42, steps: 80, accounts: 3 });
  assert.equal(run.seed, 42);
  run.ops.forEach((op, index) => {
    assert.equal(op.seq, index);
    assert.equal(op.id, `op-${index}`);
    assert.ok(op.result === 'applied' || op.result === 'rejected');
    assert.ok(Array.isArray(op.samples) && op.samples.length >= 1);
    for (const sample of op.samples) {
      assert.ok(Number.isInteger(sample.seq));
      assert.ok(Number.isInteger(sample.value));
      assert.equal(typeof sample.purpose, 'string');
    }
  });
  const initSamples = run.accounts + 1;
  assert.equal(run.ops.reduce((n, op) => n + op.samples.length, 0) + initSamples, run.sampleCount);
});

test('identical seeds produce byte-identical runs', () => {
  const a = JSON.stringify(fuzzRun({ seed: 42, steps: 80, accounts: 3 }), null, 2) + '\n';
  const b = JSON.stringify(fuzzRun({ seed: 42, steps: 80, accounts: 3 }), null, 2) + '\n';
  assert.equal(a, b);
  console.log(`byteIdenticalRerun=${a === b} bytes=${a.length}`);
});

test('replay reproduces state hash, op results and random samples exactly', () => {
  const run = fuzzRun({ seed: 42, steps: 80, accounts: 3 });
  const outcome = replayRun(run);
  console.log(`replayOk=${outcome.ok} finalStateHash=${outcome.finalStateHash} sampleHash=${outcome.sampleHash} mismatches=${outcome.mismatches.length}`);
  assert.equal(outcome.ok, true, outcome.mismatches.join('\n'));
  assert.equal(outcome.finalStateHash, run.finalStateHash);
  assert.equal(outcome.sampleHash, run.sampleHash);
});

test('replay detects tampered results', () => {
  const run = fuzzRun({ seed: 42, steps: 80, accounts: 3 });
  const tampered = JSON.parse(JSON.stringify(run));
  tampered.ops[0].result = tampered.ops[0].result === 'applied' ? 'rejected' : 'applied';
  assert.equal(replayRun(tampered).ok, false);
});

test('exhaustive interleaving enumerator matches engine for plans of <=4 steps', () => {
  for (const seed of [0, 1, 2, 3, 7, 42, 1234]) {
    for (const steps of [1, 2, 3, 4]) {
      const run = fuzzRun({ seed, steps, accounts: 2 });
      const balances = run.initial.accounts.map((account) => account.balance);
      const frozen = run.initial.accounts
        .map((account, index) => (account.frozen ? index : -1))
        .filter((index) => index >= 0);
      const concreteOps = run.ops.map((op) => {
        const base = { id: op.id, type: op.type, reservationId: op.reservationId };
        if (op.type === 'reserve') {
          base.account = op.account;
          base.amount = op.amount;
        }
        return base;
      });
      const allOrders = enumerateFinalStates(balances, frozen, concreteOps);
      assert.equal(allOrders.length, factorial(steps));
      const identity = allOrders.find((entry) => entry.order.every((id, i) => id === `op-${i}`));
      assert.ok(identity, 'identity order must be enumerated');
      assert.equal(
        canonicalString(identity.state),
        canonicalString(run.finalState),
        `seed=${seed} steps=${steps}: engine disagrees with independent enumerator`,
      );
      for (const entry of allOrders) {
        for (const account of entry.state.accounts) {
          assert.ok(account.held >= 0, `held negative in order ${entry.order}`);
          assert.ok(account.balance - account.held >= 0, `available negative in order ${entry.order}`);
        }
      }
    }
  }
  console.log('enumeratorCrossCheck=PASS seeds=7 stepsPerSeed=4');
});

function factorial(n) {
  return n <= 1 ? 1 : n * factorial(n - 1);
}
