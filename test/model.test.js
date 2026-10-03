// Reference-model tests: a small tree is explored by recursively enumerating
// every allowed state transition of every node, checking the implementation
// against the reference transition table and budget invariants at each step.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as m from '../src/model.js';

// Reference table: op -> { fromState: [allowed result states] }.
// Absent fromState means the op is rejected in that state.
const REFERENCE = {
  prepare: { OPEN: ['PREPARED'] },
  commit: { PREPARED: ['SETTLED'] },
  cancel: {
    OPEN: ['CANCELLED', 'PARTIAL'],
    PREPARED: ['CANCELLED', 'PARTIAL'],
    PARTIAL: ['CANCELLED', 'PARTIAL'],
  },
};

const OPS = {
  prepare: (state, id) => m.prepare(state, id),
  commit: (state, id) => m.applyCommit(state, id),
  cancel: (state, id) => m.applyCancel(state, id),
};

function buildSmallTree() {
  const state = m.emptyState();
  m.createGroup(state, { id: 'root', amount: 1000 });
  m.createGroup(state, { id: 'a', parentId: 'root', amount: 400 });
  m.createGroup(state, { id: 'a1', parentId: 'a', amount: 150 });
  m.createGroup(state, { id: 'a2', parentId: 'a', amount: 100 });
  m.createGroup(state, { id: 'b', parentId: 'root', amount: 300 });
  return state;
}

test('reference table: every node state accepts exactly the allowed transitions', () => {
  for (const stateName of m.STATES) {
    for (const [op, table] of Object.entries(REFERENCE)) {
      const allowed = table[stateName];
      const state = buildSmallTree();
      state.groups.a1.state = stateName; // leaf, no children to interfere
      if (!allowed) {
        assert.throws(
          () => OPS[op](state, 'a1'),
          (err) => err instanceof m.ModelError && err.code === 'INVALID_TRANSITION',
          `${op} must reject state ${stateName}`,
        );
        assert.equal(state.groups.a1.state, stateName, 'rejected op must not mutate state');
      } else {
        OPS[op](state, 'a1');
        assert.ok(
          allowed.includes(state.groups.a1.state),
          `${op} from ${stateName} must land in ${allowed}, got ${state.groups.a1.state}`,
        );
        m.assertInvariants(state);
      }
    }
  }
});

test('terminal states: SETTLED and CANCELLED accept no further transitions', () => {
  for (const terminal of ['SETTLED', 'CANCELLED']) {
    for (const op of Object.keys(OPS)) {
      const state = buildSmallTree();
      state.groups.b.state = terminal;
      // keep invariants consistent with the forced state
      state.groups.root.reserved = 400;
      state.groups.root.spent = terminal === 'SETTLED' ? 300 : 0;
      assert.throws(() => OPS[op](state, 'b'), m.ModelError);
    }
  }
});

test('recursive enumeration of allowed transitions preserves invariants and SETTLED nodes', () => {
  const initial = buildSmallTree();
  const visited = new Set();
  const keyOf = (state) =>
    JSON.stringify(
      Object.values(state.groups)
        .map((g) => [g.id, g.state, g.reserved, g.spent])
        .sort(),
    );

  let explored = 0;
  const dfs = (state, depth) => {
    explored += 1;
    m.assertInvariants(state);
    const settledBefore = Object.values(state.groups)
      .filter((g) => g.state === 'SETTLED')
      .map((g) => g.id);
    if (depth === 0) return;
    for (const id of Object.keys(state.groups)) {
      const from = state.groups[id].state;
      for (const [op, table] of Object.entries(REFERENCE)) {
        if (!table[from]) continue; // reference says: rejected, skip
        const next = structuredClone(state);
        OPS[op](next, id);
        // SETTLED is absorbing: no op may ever unsettle a node
        for (const sid of settledBefore) {
          assert.equal(next.groups[sid].state, 'SETTLED', `${op} unsettled ${sid}`);
        }
        m.assertInvariants(next);
        const key = keyOf(next);
        if (!visited.has(key)) {
          visited.add(key);
          dfs(next, depth - 1);
        }
      }
    }
  };
  dfs(initial, 6);
  assert.ok(explored > 50, `expected a meaningful state space, explored ${explored}`);
});

test('budget conservation: reserved + spent + available == amount at every node', () => {
  const state = buildSmallTree();
  m.prepare(state, 'a1');
  m.applyCommit(state, 'a1');
  m.applyCancel(state, 'a2');
  m.applyCancel(state, 'b');
  for (const g of Object.values(state.groups)) {
    assert.equal(g.reserved + g.spent + m.available(g), g.amount);
  }
});
