// Independent enumerator: exhaustively combines cancel points (which branch
// fails), failure budgets (how many consecutive attempts fail), duplicate
// cancel requests and duplicate ACKs, then asserts the engine reaches the
// directly computed expected state.
import test from 'node:test';
import assert from 'node:assert/strict';
import { TradingEngine, BRANCHES } from '../src/engine.js';

const INITIAL = 500;
const AMOUNT = 80;
const FEE = 5;

const CANCEL_POINTS = [null, ...BRANCHES]; // branch whose attempts fail
const FAIL_COUNTS = [1, 2];                // consecutive failures at that point
const REPEATS = [1, 2, 3];                 // duplicate cancel requests
const DUP_ACKS = [0, 1, 2];                // duplicate ACKs per branch

// Directly compute the expected ledger after `count` branches (in canonical
// order UNDO_MATCH, REFUND_FEE, RELEASE_RESERVE) have been compensated.
function expectedState(count) {
  return {
    available:
      INITIAL - AMOUNT - FEE +
      (count > 1 ? FEE : 0) +   // REFUND_FEE is branch #2
      (count > 2 ? AMOUNT : 0), // RELEASE_RESERVE is branch #3
    reserved: count > 2 ? 0 : AMOUNT,
    fees: count > 1 ? 0 : FEE,
    openMatches: count > 0 ? 0 : 1,
  };
}

function assertState(engine, count) {
  const expected = expectedState(count);
  const account = engine.getAccount('acct');
  assert.equal(account.available, expected.available, 'available');
  assert.equal(account.reserved, expected.reserved, 'reserved');
  assert.equal(engine.state.feesCollected, expected.fees, 'fees');
  assert.equal(Object.keys(engine.state.matches).length, expected.openMatches, 'matches');
}

// Fail the given branches with the given failure budgets (across retries).
function failingHooks(budgets) {
  const remaining = new Map(Object.entries(budgets));
  const hooks = {};
  for (const branch of remaining.keys()) {
    hooks[branch] = () => {
      if (remaining.get(branch) > 0) {
        remaining.set(branch, remaining.get(branch) - 1);
        throw new Error(`injected ${branch}`);
      }
    };
  }
  return hooks;
}

test('enumerator: cancel points x failure budgets x repeats x duplicate ACKs', () => {
  for (const point of CANCEL_POINTS) {
    const failCounts = point === null ? [0] : FAIL_COUNTS;
    for (const failCount of failCounts) {
      // Second failing branch: any branch at or after the first cancel point
      // (earlier branches are already ACKed when it is reached).
      const secondPoints =
        point === null ? [null] : [null, ...BRANCHES.slice(BRANCHES.indexOf(point) + 1)];
      for (const point2 of secondPoints) {
        for (const repeats of REPEATS) {
          for (const dupAcks of DUP_ACKS) {
            const engine = new TradingEngine();
            engine.deposit('acct', INITIAL);
            engine.executeTrade({ tradeId: 't', accountId: 'acct', amount: AMOUNT, fee: FEE });

            // Expected failure sequence (directly computed): point x failCount,
            // then point2 x 1, then success. Cancel requests are retried until
            // the saga completes; already-ACKed branches are skipped.
            const expectedFailures = [
              ...Array(failCount).fill(point),
              ...(point2 ? [point2] : []),
            ].filter((b) => b !== null);
            let observedFailures = [];
            let result = null;
            const hooks = failingHooks({
              [point]: failCount,
              ...(point2 ? { [point2]: 1 } : {}),
            });
            for (let i = 0; i < expectedFailures.length + 1; i += 1) {
              result = engine.cancelTrade('t', hooks);
              if (result.status === 'CANCELLED') break;
              observedFailures.push(result.failed.branch);
              assert.equal(result.status, 'CANCELLING');
              assertState(engine, BRANCHES.indexOf(result.failed.branch));
            }
            assert.deepEqual(observedFailures, expectedFailures);
            assert.equal(result.status, 'CANCELLED');
            assert.deepEqual(result.certificate.compensated, BRANCHES);
            assertState(engine, 3);

            // Duplicate cancel requests: idempotent, identical certificate.
            for (let i = 0; i < repeats; i += 1) {
              const again = engine.cancelTrade('t');
              assert.equal(again.status, 'CANCELLED');
              assert.deepEqual(again.certificate, result.certificate);
            }
            // Duplicate ACKs: no branch compensates twice.
            for (const branch of BRANCHES) {
              for (let i = 0; i < dupAcks; i += 1) {
                assert.equal(engine.acknowledge('t', branch).applied, false);
              }
            }
            assertState(engine, 3);
            assert.equal(engine.getTrade('t').compensationLog.length, 3);
          }
        }
      }
    }
  }
});

test('enumerator: irreversible trades reject cancellation at every cancel point', () => {
  for (const point of CANCEL_POINTS) {
    const engine = new TradingEngine();
    engine.deposit('acct', INITIAL);
    engine.executeTrade({
      tradeId: 't', accountId: 'acct', amount: AMOUNT, fee: FEE, irreversible: true,
    });
    const before = JSON.stringify(engine.state);
    assert.throws(
      () => engine.cancelTrade('t', failingHooks({ [point]: 1 })),
      (err) => err.code === 'IRREVERSIBLE_CONFLICT',
    );
    assert.equal(JSON.stringify(engine.state), before);
    assertState(engine, 0);
  }
});
