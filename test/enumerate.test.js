import test from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../src/engine.js';

// Acceptance 1: enumerate event sequences (length <= 9) and check the final
// good/defective/rework inventories against an independent oracle reducer.

// Independent reference model: a deliberately plain fold over the sequence.
function oracle(seq) {
  let good = 0;
  let defective = 0;
  let rework = 0;
  const status = new Map();
  let down = false;
  const queue = [];

  function step([type, id]) {
    switch (type) {
      case 'I':
        if (!status.has(id)) status.set(id, 'pending');
        break;
      case 'A':
        if (status.get(id) === 'pending') {
          status.set(id, 'accepted');
          good += 1;
        }
        break;
      case 'R':
        if (status.get(id) === 'pending') {
          status.set(id, 'rejected');
          defective += 1;
        }
        break;
      case 'S':
        if (status.get(id) === 'rejected') {
          status.set(id, 'reworking');
          defective -= 1;
          rework += 1;
        }
        break;
      case 'D':
        if (status.get(id) === 'reworking') {
          status.set(id, 'done');
          rework -= 1;
          good += 1;
        }
        break;
      case 'V': {
        const s = status.get(id);
        if (s === 'pending') status.set(id, 'voided');
        else if (s === 'accepted') { status.set(id, 'voided'); good -= 1; }
        else if (s === 'rejected') { status.set(id, 'voided'); defective -= 1; }
        else if (s === 'reworking') { status.set(id, 'voided'); rework -= 1; }
        break;
      }
      case 'H':
        down = true;
        break;
      case 'T':
        down = false;
        while (queue.length > 0 && !down) step(queue.shift());
        break;
      default:
        break;
    }
  }

  for (const e of seq) {
    if (down && e[0] !== 'T') queue.push(e);
    else step(e);
  }
  return { good, defective, rework, pending: queue.length };
}

const NAMES = {
  I: 'inspect',
  A: 'accept',
  R: 'reject',
  S: 'rework_start',
  D: 'rework_done',
  V: 'void_inspect',
  H: 'shutdown',
  T: 'restart',
};

function runEngine(seq) {
  const engine = createEngine();
  seq.forEach(([type, id], i) => {
    engine.handle({ seq: i + 1, type: NAMES[type], id });
  });
  const { state, moves } = engine.result();
  // Invariants that must hold for every prefix of every sequence.
  for (const m of moves) {
    assert.ok(m.state.good >= 0, `good went negative: ${JSON.stringify(m)}`);
    assert.ok(m.state.defective >= 0, `defective went negative: ${JSON.stringify(m)}`);
    assert.ok(m.state.rework >= 0, `rework went negative: ${JSON.stringify(m)}`);
  }
  // applySeq must be strictly increasing and seq never decreases within a
  // drain (no reordering across restart).
  for (let i = 1; i < moves.length; i += 1) {
    assert.ok(moves[i].applySeq > moves[i - 1].applySeq);
  }
  return state;
}

function check(seq) {
  const expected = oracle(seq);
  const actual = runEngine(seq);
  assert.deepEqual(
    actual,
    expected,
    `mismatch for ${JSON.stringify(seq)}: engine=${JSON.stringify(actual)} oracle=${JSON.stringify(expected)}`,
  );
}

const SYM1 = ['I', 'A', 'R', 'S', 'D', 'V', 'H', 'T'];

test('acceptance 1: exhaustive enumeration, 1 id, length <= 5', () => {
  let count = 0;
  const seq = [];
  function dfs(depth) {
    if (depth > 0) {
      check(seq);
      count += 1;
    }
    if (depth === 5) return;
    for (const s of SYM1) {
      seq.push([s, 'a']);
      dfs(depth + 1);
      seq.pop();
    }
  }
  dfs(0);
  assert.equal(count, 8 + 64 + 512 + 4096 + 32768);
});

test('acceptance 1: seeded random enumeration, 2 ids, length 6..9', () => {
  // deterministic LCG so the run is reproducible
  let seed = 0xC0FFEE;
  const rand = (n) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % n;
  };
  const idSyms = ['I', 'A', 'R', 'S', 'D', 'V'];
  for (let iter = 0; iter < 4000; iter += 1) {
    const len = 6 + rand(4); // 6..9
    const seq = [];
    for (let i = 0; i < len; i += 1) {
      const pick = rand(14);
      if (pick < 12) seq.push([idSyms[pick % 6], pick < 6 ? 'a' : 'b']);
      else seq.push([pick === 12 ? 'H' : 'T', undefined]);
    }
    check(seq);
  }
});
