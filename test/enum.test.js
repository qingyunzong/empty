'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Terminal } = require('../lib/terminal');
const { chainFrames, hashes } = require('./helpers');

function* permutations(n) {
  const a = Array.from({ length: n }, (_, i) => i);
  yield a.slice();
  const c = new Array(n).fill(0);
  let i = 0;
  while (i < n) {
    if (c[i] < i) {
      const j = i % 2 === 0 ? 0 : c[i];
      [a[i], a[j]] = [a[j], a[i]];
      yield a.slice();
      c[i]++;
      i = 0;
    } else {
      c[i] = 0;
      i++;
    }
  }
}

// Acceptance 5: for n <= 8 operations from two concurrent actors, every
// delivery interleaving must converge to the reference serial chain.
test('acceptance 5: all interleavings of <=8 ops match the reference serializer', () => {
  for (let n = 1; n <= 8; n++) {
    const ops = [];
    for (let i = 0; i < n; i++) {
      ops.push({ actor: i % 2 === 0 ? 'alice' : 'bob', args: { key: 'k' + i, value: i } });
    }
    const frames = chainFrames(ops);
    const ref = new Terminal(null);
    for (const f of frames) ref.submit(f);
    const expected = hashes(ref);

    let checked = 0;
    for (const perm of permutations(n)) {
      const term = new Terminal(null);
      for (const idx of perm) term.submit(frames[idx]);
      assert.equal(term.pending.length, 0, `n=${n} perm=${perm}`);
      assert.deepEqual(hashes(term), expected, `n=${n} perm=${perm}`);
      checked++;
    }
    assert.equal(checked, factorial(n));
  }
});

test('interleavings preserve final state, not just hashes', () => {
  const n = 6;
  const ops = [];
  for (let i = 0; i < n; i++) {
    ops.push({ actor: i % 2 === 0 ? 'alice' : 'bob', args: { key: 'k' + (i % 3), value: i } });
  }
  const frames = chainFrames(ops);
  const ref = new Terminal(null);
  for (const f of frames) ref.submit(f);
  const expectedState = [...ref.state.entries()].sort();
  for (const perm of permutations(n)) {
    const term = new Terminal(null);
    for (const idx of perm) term.submit(frames[idx]);
    assert.deepEqual([...term.state.entries()].sort(), expectedState, `perm=${perm}`);
  }
});

function factorial(n) {
  let r = 1;
  for (let i = 2; i <= n; i++) r *= i;
  return r;
}
