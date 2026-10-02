'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { planFromData } = require('../lib/core');

// 单文件状态机: eq / onlyA / onlyB / updA / updB / conflict / delA / delB
const STATES5 = ['eq', 'onlyA', 'onlyB', 'updA', 'conflict'];
const STATES8 = [...STATES5, 'updB', 'delA', 'delB'];

function buildCase(combo) {
  const scanA = new Map();
  const scanB = new Map();
  const stA = { version: 1, entries: {} };
  const stB = { version: 1, entries: {} };
  const expected = [];
  combo.forEach((s, i) => {
    const key = `m${i}|2026-01-0${(i % 9) + 1}|CNY`;
    const eA = (h) => ({ key, fileName: 'f.csv', path: `/A/f.csv`, hash: h, mtimeMs: 1000 + i, size: 10 });
    const eB = (h) => ({ key, fileName: 'f.csv', path: `/B/f.csv`, hash: h, mtimeMs: 2000 + i, size: 10 });
    const base = (h) => ({ hash: h, deleted: false, mtimeMs: 500 + i });
    switch (s) {
      case 'eq':
        scanA.set(key, eA(`h${i}`));
        scanB.set(key, eB(`h${i}`));
        stA.entries[key] = base(`h${i}`);
        stB.entries[key] = base(`h${i}`);
        break;
      case 'onlyA':
        scanA.set(key, eA(`h${i}`));
        expected.push({ type: 'copy', key, from: 'a' });
        break;
      case 'onlyB':
        scanB.set(key, eB(`h${i}`));
        expected.push({ type: 'copy', key, from: 'b' });
        break;
      case 'updA':
        scanA.set(key, eA(`new${i}`));
        scanB.set(key, eB(`old${i}`));
        stA.entries[key] = base(`old${i}`);
        stB.entries[key] = base(`old${i}`);
        expected.push({ type: 'copy', key, from: 'a' });
        break;
      case 'updB':
        scanA.set(key, eA(`old${i}`));
        scanB.set(key, eB(`new${i}`));
        stA.entries[key] = base(`old${i}`);
        stB.entries[key] = base(`old${i}`);
        expected.push({ type: 'copy', key, from: 'b' });
        break;
      case 'conflict':
        scanA.set(key, eA(`x${i}`));
        scanB.set(key, eB(`y${i}`));
        stA.entries[key] = base(`base${i}`);
        stB.entries[key] = base(`base${i}`);
        expected.push({ type: 'conflict', key });
        break;
      case 'delA': // A 删除了, B 未动 → 传播删除到 B
        scanB.set(key, eB(`h${i}`));
        stA.entries[key] = base(`h${i}`);
        stB.entries[key] = base(`h${i}`);
        expected.push({ type: 'delete', key, dir: 'b' });
        break;
      case 'delB':
        scanA.set(key, eA(`h${i}`));
        stA.entries[key] = base(`h${i}`);
        stB.entries[key] = base(`h${i}`);
        expected.push({ type: 'delete', key, dir: 'a' });
        break;
      default:
        throw new Error(`bad state ${s}`);
    }
  });
  return { scanA, scanB, stA, stB, expected };
}

function* enumerate(states, n, prefix = []) {
  if (prefix.length === n) {
    yield prefix;
    return;
  }
  for (const s of states) yield* enumerate(states, n, [...prefix, s]);
}

function checkCombo(combo, checkDeterminism) {
  const { scanA, scanB, stA, stB, expected } = buildCase(combo);
  const input = { dirs: { a: '/A', b: '/B' }, scanA, scanB, stateA: stA, stateB: stB };
  const plan = planFromData(input);

  // 最小性 1: 操作数 == 需要动作的键数 (eq 零操作, 其余每键恰好一个)
  assert.strictEqual(plan.ops.length, expected.length, `combo=${combo} 操作数不最小`);

  // 最小性 2: 每个键至多一个操作, 且类型/方向正确
  const seen = new Set();
  for (const op of plan.ops) {
    assert.ok(!seen.has(op.key), `键 ${op.key} 出现重复操作`);
    seen.add(op.key);
    const exp = expected.find((e) => e.key === op.key);
    assert.ok(exp, `键 ${op.key} 不应有操作`);
    assert.strictEqual(op.type, exp.type, `键 ${op.key} 操作类型错误`);
    if (exp.from) assert.strictEqual(op.from, exp.from);
    if (exp.dir) assert.strictEqual(op.dir, exp.dir);
  }

  // 最小性 3: 计划确定性 (同输入 → 同 planHash), 抽样验证
  if (checkDeterminism) {
    const plan2 = planFromData(input);
    assert.strictEqual(plan.planHash, plan2.planHash);
  }
}

test('验收4: n≤7 枚举文件状态, 对照 plan 最小性', () => {
  let count = 0;
  // n=1..3: 全 8 状态枚举 (8+64+512)
  for (let n = 1; n <= 3; n++) {
    for (const combo of enumerate(STATES8, n)) {
      checkCombo(combo, count % 50 === 0);
      count++;
    }
  }
  // n=4..7: 5 状态枚举 (625+3125+15625+78125)
  for (let n = 4; n <= 7; n++) {
    for (const combo of enumerate(STATES5, n)) {
      checkCombo(combo, count % 50 === 0);
      count++;
    }
  }
  console.log(`minimality: 共验证 ${count} 种组合`);
});
