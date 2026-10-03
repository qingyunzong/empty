import test from 'node:test';
import assert from 'node:assert/strict';
import { STATES, STATE_TRANSITIONS, allowedOperations, Ledger } from '../src/ledger.js';
import { LedgerError } from '../src/errors.js';
import { tempDir, openLedger, buildTree } from './helpers.js';

// Independent reference model of the allowed transitions, written directly
// from the specification. The library table must match it exactly.
const REFERENCE_TRANSITIONS = {
  OPEN: { prepare: 'PREPARED', cancel: ['CANCELLED', 'PARTIAL'] },
  PREPARED: { commit: 'SETTLED', rollback: 'OPEN' },
  SETTLED: {},
  CANCELLED: {},
  PARTIAL: { cancel: ['PARTIAL'] },
};

test('transition table matches the reference enumeration for every state', () => {
  assert.deepEqual(STATES, Object.keys(REFERENCE_TRANSITIONS));
  for (const state of STATES) {
    assert.deepEqual(STATE_TRANSITIONS[state], REFERENCE_TRANSITIONS[state], `transitions for ${state}`);
    assert.deepEqual(allowedOperations(state), Object.keys(REFERENCE_TRANSITIONS[state]));
  }
});

function nodeIds(ledger, id) {
  return [id, ...ledger.childrenOf(id).flatMap((child) => nodeIds(ledger, child))];
}

// Recursively walk the small tree and, for every node and every reachable
// state, verify that each operation behaves exactly as the reference allows.
test('recursive per-node behavior matches the reference transitions', () => {
  const OPS = ['prepare', 'commit', 'cancel'];
  const probe = buildTree(tempDir());
  const ids = nodeIds(probe, 'root');
  for (const state of STATES) {
    for (const id of ids) {
      // A leaf can never genuinely be PARTIAL (no descendants to settle).
      if (state === 'PARTIAL' && probe.childrenOf(id).length === 0) continue;
      for (const op of OPS) {
        const ledger = buildTree(tempDir());
        if (state === 'PARTIAL') {
          // Construct a genuine PARTIAL node: one child independently settled.
          const child = ledger.childrenOf(id)[0];
          ledger.prepare(child);
          ledger.commit(child);
        }
        ledger.groups[id].state = state;
        const reference = REFERENCE_TRANSITIONS[state];
        const allowed = Object.prototype.hasOwnProperty.call(reference, op);
        if (!allowed) {
          assert.throws(
            () => ledger[op](id),
            (err) => err instanceof LedgerError,
            `${op} on ${id} in state ${state} must be rejected`,
          );
          continue;
        }
        const result = ledger[op](id);
        const expected = reference[op];
        const targets = Array.isArray(expected) ? expected : [expected];
        assert.ok(
          targets.includes(result.state),
          `${op} on ${id} in state ${state} must land in ${targets}, got ${result.state}`,
        );
      }
    }
  }
});

test('rollback transition PREPARED -> OPEN happens through crash recovery', () => {
  const dir = tempDir();
  const ledger = buildTree(dir);
  ledger.prepare('alpha');
  assert.equal(ledger.getView('alpha').state, 'PREPARED');
  const recovered = openLedger(dir); // restart without COMMIT => rollback
  assert.equal(recovered.getView('alpha').state, 'OPEN');
});

test('Ledger is exported and constructible against a fresh store', () => {
  const dir = tempDir();
  const ledger = openLedger(dir);
  assert.ok(ledger instanceof Ledger);
});
