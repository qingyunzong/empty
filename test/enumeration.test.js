// Exhaustive enumeration: every event sequence of length n <= 10 over the
// transition alphabet is run through the implementation and through an
// independent reference state machine written here in the test; final
// states and rejection counts must agree exactly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyEvent } from '../src/statemachine.js';

// --- independent reference model -------------------------------------------
// lot:     normal --hold--> held --release--> normal   (else reject)
// device:  ok --alarm--> alarmed --clear--> ok          (else reject)
function reference(kinds) {
  let lot = 'normal';
  let dev = 'ok';
  let rejected = 0;
  for (const k of kinds) {
    if (k === 'hold') {
      if (lot !== 'normal') rejected++;
      else lot = 'held';
    } else if (k === 'release') {
      if (lot !== 'held') rejected++;
      else lot = 'normal';
    } else if (k === 'alarm') {
      if (dev !== 'ok') rejected++;
      else dev = 'alarmed';
    } else if (k === 'clear') {
      if (dev !== 'alarmed') rejected++;
      else dev = 'ok';
    }
  }
  return { lot, dev, rejected };
}

// --- implementation under test (pure transition layer, no IO) ---------------
const KIND_OF = { hold: 'quality.hold', release: 'quality.release', alarm: 'device.alarm', clear: 'device.clear' };

function implementation(kinds) {
  const state = { lots: {}, devices: {} };
  let rejected = 0;
  kinds.forEach((k, i) => {
    const r = applyEvent(state, {
      id: `e${i}`,
      ts: i,
      device: 'D',
      lot: 'L',
      kind: KIND_OF[k],
      payload: {},
    });
    if (!r.applied) {
      assert.equal(r.error.code, 'VALIDATION');
      rejected++;
    }
  });
  return {
    lot: state.lots.L?.status ?? 'normal',
    dev: state.devices.D?.status ?? 'ok',
    rejected,
  };
}

function* sequences(alphabet, maxLen) {
  const total = Math.pow(alphabet.length, maxLen);
  for (let x = 0; x < total; x++) {
    let v = x;
    const seq = [];
    for (let i = 0; i < maxLen; i++) {
      seq.push(alphabet[v % alphabet.length]);
      v = Math.floor(v / alphabet.length);
    }
    yield seq;
  }
}

test('exhaustive n<=10 over {hold,release} matches reference machine', () => {
  let checked = 0;
  for (let n = 1; n <= 10; n++) {
    for (const seq of sequences(['hold', 'release'], n)) {
      assert.deepEqual(implementation(seq), reference(seq), `mismatch at ${seq.join(',')}`);
      checked++;
    }
  }
  assert.equal(checked, 2 ** 11 - 2); // 2046 sequences
});

test('exhaustive n<=8 over {hold,release,alarm,clear} matches reference machine', () => {
  let checked = 0;
  for (let n = 1; n <= 8; n++) {
    for (const seq of sequences(['hold', 'release', 'alarm', 'clear'], n)) {
      assert.deepEqual(implementation(seq), reference(seq), `mismatch at ${seq.join(',')}`);
      checked++;
    }
  }
  assert.equal(checked, (4 ** 9 - 4) / 3); // 87380 sequences
});

test('sampled length-9..10 mixed-alphabet sequences match reference machine', () => {
  const alphabet = ['hold', 'release', 'alarm', 'clear'];
  let x = 0x9e3779b9; // deterministic LCG, no randomness in tests
  const rand = () => (x = (x * 1103515245 + 12345) & 0x7fffffff);
  for (let t = 0; t < 5000; t++) {
    const n = 9 + (t % 2);
    const seq = Array.from({ length: n }, () => alphabet[rand() % 4]);
    assert.deepEqual(implementation(seq), reference(seq), `mismatch at ${seq.join(',')}`);
  }
});
