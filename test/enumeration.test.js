'use strict';

// Acceptance 1: for graphs of at most 8 nodes, compare the incremental
// engine against the enumeration reference (clear + full recompute after
// every transaction) on values, diff sets and certificates.

const test = require('node:test');
const assert = require('node:assert/strict');
const { runRequest } = require('../src/engine');
const { runRequestReference } = require('../src/reference');

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const OPS = ['sum', 'min', 'max', 'avg', 'concat'];

function randValue(rnd) {
  return rnd() < 0.7 ? Math.floor(rnd() * 21) - 10 : String.fromCharCode(97 + Math.floor(rnd() * 4));
}

function genRequest(seed) {
  const rnd = mulberry32(seed);
  const nodeCount = 2 + Math.floor(rnd() * 5); // 2..6 initial nodes (addNode may grow to 8)
  const ids = [];
  for (let i = 0; i < nodeCount; i++) ids.push('n' + i);

  // Random topological ranks: edges only go from lower rank to higher rank,
  // so the initial graph is always acyclic.
  const shuffled = [...ids].sort(() => rnd() - 0.5);
  const rank = new Map(shuffled.map((id, i) => [id, i]));

  const kinds = {};
  for (const id of ids) kinds[id] = rnd() < 0.5 ? 'source' : 'derived';
  if (!Object.values(kinds).includes('source')) kinds[ids[0]] = 'source';
  if (!Object.values(kinds).includes('derived')) kinds[ids[1]] = 'derived';

  const nodes = ids.map((id) => {
    if (kinds[id] === 'source') return { id, kind: 'source', value: randValue(rnd) };
    const earlier = ids.filter((o) => rank.get(o) < rank.get(id));
    const inputs = [];
    for (const cand of earlier) {
      if (inputs.length < 3 && rnd() < 0.5) inputs.push(cand);
    }
    return { id, kind: 'derived', op: OPS[Math.floor(rnd() * OPS.length)], inputs };
  });

  const txCount = 1 + Math.floor(rnd() * 6);
  const transactions = [];
  let added = 0;
  let extra = 0;
  for (let i = 0; i < txCount; i++) {
    const opCount = 1 + Math.floor(rnd() * 4);
    const ops = [];
    for (let j = 0; j < opCount; j++) {
      const pick = rnd();
      const randId = () => ids[Math.floor(rnd() * ids.length)];
      if (pick < 0.35) {
        ops.push({ type: 'setSource', node: randId(), value: randValue(rnd) });
      } else if (pick < 0.55) {
        ops.push({ type: 'addEdge', from: randId(), to: randId() });
      } else if (pick < 0.7) {
        ops.push({ type: 'removeEdge', from: randId(), to: randId() });
      } else if (pick < 0.8 && added < 2) {
        added += 1;
        const id = 'x' + extra++;
        ids.push(id);
        const kind = rnd() < 0.5 ? 'source' : 'derived';
        const node = kind === 'source'
          ? { id, kind, value: randValue(rnd) }
          : { id, kind, op: OPS[Math.floor(rnd() * OPS.length)] };
        if (kind === 'derived' && rnd() < 0.7) {
          node.inputs = [randId()];
        }
        ops.push({ type: 'addNode', node });
      } else if (pick < 0.87) {
        ops.push({ type: 'removeNode', node: randId() });
      } else {
        const tags = ['u0', 'u1', 'u2', 'missing'];
        ops.push({ type: 'undo', undoTag: tags[Math.floor(rnd() * tags.length)] });
      }
    }
    const tx = { id: 't' + i, ops };
    if (rnd() < 0.5) tx.undoTag = 'u' + Math.floor(rnd() * 3);
    transactions.push(tx);
  }
  return { state: { nodes }, transactions };
}

function sortedErrors(errors) {
  return [...(errors || [])].map((e) => ({ code: e.code, node: e.node }))
    .sort((a, b) => (a.node < b.node ? -1 : a.node > b.node ? 1 : 0));
}

function compareRequests(seed) {
  const req = genRequest(seed);
  const inc = runRequest(req);
  const ref = runRequestReference(req);
  const ctx = `seed=${seed} req=${JSON.stringify(req)}`;

  assert.equal(inc.ok, ref.ok, `ok mismatch\n${ctx}`);
  if (!inc.ok) {
    assert.equal(inc.error.code, ref.error.code, `load error mismatch\n${ctx}`);
    return;
  }
  assert.deepEqual(
    sortedErrors(inc.initialErrors), sortedErrors(ref.initialErrors),
    `initial errors mismatch\n${ctx}`,
  );
  assert.equal(inc.results.length, ref.results.length, `result count\n${ctx}`);
  for (let i = 0; i < inc.results.length; i++) {
    const a = inc.results[i];
    const b = ref.results[i];
    const tctx = `tx[${i}]\n${ctx}`;
    assert.equal(a.ok, b.ok, `ok mismatch at ${tctx}`);
    if (!a.ok) {
      assert.equal(a.error.code, b.error.code, `error code at ${tctx}`);
      assert.equal(a.certificate, b.certificate, `rolled-back certificate at ${tctx}`);
      assert.deepEqual(a.state, b.state, `rolled-back state at ${tctx}`);
      continue;
    }
    // Values + blocked flags (via full certificate), diff sets, version.
    assert.equal(a.certificate, b.certificate, `certificate at ${tctx}`);
    assert.equal(a.version, b.version, `version at ${tctx}`);
    assert.deepEqual(a.affected, b.affected, `diff set at ${tctx}`);
  }
  assert.deepEqual(inc.final, ref.final, `final state\n${ctx}`);
}

test('incremental engine matches enumeration reference (<=8 nodes, 400 seeds)', () => {
  for (let seed = 1; seed <= 400; seed++) {
    compareRequests(seed);
  }
});

test('generated scenarios stay within the 8-node bound', () => {
  for (let seed = 1; seed <= 400; seed++) {
    const req = genRequest(seed);
    const ids = new Set();
    for (const n of req.state.nodes) ids.add(n.id);
    for (const tx of req.transactions) {
      for (const op of tx.ops) {
        if (op.type === 'addNode') ids.add(op.node.id);
      }
    }
    assert.ok(ids.size <= 8, `seed=${seed} produced ${ids.size} nodes`);
  }
});
