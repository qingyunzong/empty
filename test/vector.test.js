import test from 'node:test';
import assert from 'node:assert/strict';
import { vecLeq, vecEq, vecStrict, vecMax, vecMin } from '../src/vector.js';

test('vecLeq / vecEq / vecStrict', () => {
  assert.ok(vecLeq({ A: 1 }, { A: 1, B: 2 }));
  assert.ok(vecLeq({}, { A: 1 }));
  assert.ok(!vecLeq({ A: 2 }, { A: 1 }));
  assert.ok(vecEq({ A: 1 }, { A: 1 }));
  assert.ok(!vecEq({ A: 1 }, { A: 1, B: 1 }));
  assert.ok(vecStrict({ A: 1 }, { A: 2 }));
  assert.ok(!vecStrict({ A: 1 }, { A: 1 }));
  assert.ok(!vecStrict({ A: 1, B: 5 }, { A: 2 })); // concurrent
});

test('vecMax / vecMin', () => {
  assert.deepEqual(vecMax({ A: 1 }, { A: 2, B: 1 }), { A: 2, B: 1 });
  assert.deepEqual(vecMin([{ A: 3, B: 1 }, { A: 1, B: 4 }, { A: 2 }]), { A: 1, B: 0 });
  assert.deepEqual(vecMin([]), {});
});
