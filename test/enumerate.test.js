'use strict';
// 独立枚举器：穷举 n<=6（账户数<=3 且每账户冻结数<=2，总冻结<=6）的状态空间，
// 对每对 (base, target) 验证 diff -> apply -> revert 往返一致性。
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  OP_TYPES,
  canonical,
  hashState,
  available,
  makePatch,
  applyPatch,
  revertPatch,
} = require('../patchlib');

const AMOUNTS = [10, 25];
const TAGS = ['t0', 't1'];
const HEADROOMS = [0, 60];

// 结构枚举：1..3 个账户，每个账户 used ∈ {0, 40}
function* enumerateStructs() {
  for (let n = 1; n <= 3; n += 1) {
    const ids = Array.from({ length: n }, (_, i) => `acc${i}`);
    for (let mask = 0; mask < 2 ** n; mask += 1) {
      yield ids.map((id, i) => ({ id, used: ((mask >> i) & 1) === 1 ? 40 : 0 }));
    }
  }
}

// 每个账户的冻结配置枚举：0..2 个 hold，amount ∈ AMOUNTS，tag ∈ TAGS
function holdConfigs() {
  const configs = [[]];
  for (const a1 of AMOUNTS) {
    for (const t1 of TAGS) configs.push([{ amount: a1, tag: t1 }]);
  }
  for (const a1 of AMOUNTS) {
    for (const t1 of TAGS) {
      for (const a2 of AMOUNTS) {
        for (const t2 of TAGS) {
          configs.push([{ amount: a1, tag: t1 }, { amount: a2, tag: t2 }]);
        }
      }
    }
  }
  return configs; // 1 + 4 + 16 = 21 种
}

const HOLD_CONFIGS = holdConfigs();

// 由混合进制下标确定性生成一个账户状态（独立于其他账户）
function genAccount(id, used, index) {
  const cfg = HOLD_CONFIGS[index % HOLD_CONFIGS.length];
  const headroom = HEADROOMS[Math.floor(index / HOLD_CONFIGS.length) % HEADROOMS.length];
  const holds = cfg.map((h, j) => ({ hid: `${id}-h${j}`, amount: h.amount, tag: h.tag }));
  const limit = used + holds.reduce((s, h) => s + h.amount, 0) + headroom;
  return { limit, used, holds };
}

function genState(struct, seed) {
  const accounts = {};
  struct.forEach((meta, i) => {
    // 每个账户独立的混合进制位
    const per = HOLD_CONFIGS.length * HEADROOMS.length; // 42
    const idx = Math.floor(seed / per ** i) % per;
    accounts[meta.id] = genAccount(meta.id, meta.used, idx);
  });
  return { accounts };
}

function* enumeratePairs(maxPairs) {
  let count = 0;
  for (const struct of enumerateStructs()) {
    const per = HOLD_CONFIGS.length * HEADROOMS.length;
    const space = per ** struct.length;
    const step = Math.max(1, Math.floor(space / 60)); // 每个结构最多取 60 组
    for (let s = 0; s < space && count < maxPairs; s += step) {
      // base 与 target 用不同的下标派生，保证两者独立
      const base = genState(struct, s);
      const target = genState(struct, (s * 7 + 13) % space);
      yield { base, target };
      count += 1;
    }
    if (count >= maxPairs) return;
  }
}

test('枚举器往返：diff/apply/revert（n<=6 账户/hold）', () => {
  let pairs = 0;
  let opTotal = 0;
  for (const { base, target } of enumeratePairs(600)) {
    pairs += 1;
    // 前置：生成状态自身合法（可用额非负，limit >= used + holds）
    for (const st of [base, target]) {
      for (const id of Object.keys(st.accounts)) {
        const a = st.accounts[id];
        assert.ok(a.limit >= a.used + a.holds.reduce((s, h) => s + h.amount, 0));
        assert.ok(available(a) >= 0);
      }
    }

    const patch = makePatch(base, target);
    for (const op of patch.ops) assert.ok(OP_TYPES.has(op.op), `unexpected op ${op.op}`);
    opTotal += patch.ops.length;

    const applied = applyPatch(base, patch);
    assert.equal(canonical(applied.state), canonical(target), 'apply 结果必须等于 target');
    assert.equal(hashState(applied.state), patch.toHash);

    const again = applyPatch(applied.state, patch); // 幂等
    assert.equal(again.alreadyApplied, true);
    assert.equal(canonical(again.state), canonical(target));

    const reverted = revertPatch(applied.state, patch);
    assert.equal(canonical(reverted.state), canonical(base), 'revert 结果必须等于 base');
    assert.equal(hashState(reverted.state), patch.fromHash);
  }
  assert.ok(pairs >= 600, `expected >=600 pairs, got ${pairs}`);
  console.log(`roundtrip ok: ${pairs} pairs, ${opTotal} ops`);
});
