'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { run } = require('../lib/restate');
const { validate } = require('../lib/validate');
const { bruteForce } = require('../lib/brute');

function baseInput(overrides = {}) {
  return Object.assign(
    {
      items: [
        { id: 'cash', side: 'asset', domain: [-100, 100] },
        { id: 'ar', side: 'asset', domain: [-100, 100] },
        { id: 'ap', side: 'liability', domain: [-100, 100] },
        { id: 'equity', side: 'equity', domain: [-100, 100] },
      ],
      balances: { cash: 100, ar: 50, ap: 100, equity: 40 },
      periods: [{ id: 'P1', status: 'open' }],
      formulas: [{ id: 'bs', lhs: ['cash', 'ar'], rhs: ['ap', 'equity'] }],
      layers: [
        { id: 'L1', formulas: ['bs'], reserve: 100 },
        { id: 'L2', formulas: ['bs'], reserve: 50 },
      ],
      budget: 100000,
    },
    overrides,
  );
}

function postBalances(input, out) {
  const bal = Object.assign({}, input.balances);
  for (const line of out.entry.lines) bal[line.item] += line.amount;
  return bal;
}

test('验收1: 更正后资产=负债+权益，三表配平且分层全部发布', () => {
  const input = baseInput();
  const out = run(input);
  assert.equal(out.status, 'OK');
  assert.equal(out.period, 'P1');

  const bal = postBalances(input, out);
  assert.equal(bal.cash + bal.ar, bal.ap + bal.equity, '资产合计须等于负债加权益');

  // 同凭证借贷必须配对
  const sum = out.entry.lines.reduce((s, l) => s + l.amount, 0);
  assert.equal(sum, 0);
  assert.ok(out.entry.lines.some((l) => l.amount > 0), '须有借方分录');
  assert.ok(out.entry.lines.some((l) => l.amount < 0), '须有贷方分录');
  assert.ok(out.entry.balanced);

  // 项目选择非空且都在输入中
  assert.ok(out.items.length >= 2);
  for (const id of out.items) {
    assert.ok(input.items.some((it) => it.id === id));
  }

  // 分层状态
  assert.deepEqual(
    out.layers.map((l) => l.status),
    ['PUBLISHED', 'PUBLISHED'],
  );
  assert.equal(out.reversals, 0);
  assert.equal(out.conflict, null);
});

test('验收2: 关闭期间只能走重述项目', () => {
  const input = {
    items: [
      { id: 'cash', side: 'asset', domain: [-100, 100] },
      { id: 'ar', side: 'asset', domain: [-10, 10], restatement: true },
      { id: 'ap', side: 'liability', domain: [-100, 100] },
      { id: 'equity', side: 'equity', domain: [-10, 10], restatement: true },
    ],
    balances: { cash: 60, ar: 40, ap: 50, equity: 40 },
    periods: [
      { id: 'P2024', status: 'closed' },
      { id: 'P2025', status: 'open' },
    ],
    formulas: [{ id: 'bs', lhs: ['cash', 'ar'], rhs: ['ap', 'equity'] }],
    constraints: { period: 'P2024' },
    budget: 100000,
  };
  const out = run(input);
  assert.equal(out.status, 'OK');
  assert.equal(out.period, 'P2024', '必须落在被指定的关闭期间');
  for (const id of out.items) {
    const item = input.items.find((it) => it.id === id);
    assert.equal(item.restatement, true, `关闭期间不得使用非重述项目 ${id}`);
  }
  const bal = postBalances(input, out);
  assert.equal(bal.cash + bal.ar, bal.ap + bal.equity);
});

test('关闭期间若无可用重述项目则 UNSAT', () => {
  const input = {
    items: [
      { id: 'cash', side: 'asset', domain: [-100, 100] },
      { id: 'equity', side: 'equity', domain: [-100, 100] },
    ],
    balances: { cash: 100, equity: 90 },
    periods: [{ id: 'P2024', status: 'closed' }],
    formulas: [{ id: 'bs', lhs: ['cash'], rhs: ['equity'] }],
    constraints: { period: 'P2024' },
    budget: 100000,
  };
  const out = run(input);
  assert.equal(out.status, 'UNSAT');
});

test('验收4: 无可行更正时 UNSAT 且给出最小公式冲突', () => {
  const input = baseInput({
    items: [
      { id: 'cash', side: 'asset', domain: [-2, 2] },
      { id: 'ar', side: 'asset', domain: [-2, 2] },
      { id: 'ap', side: 'liability', domain: [-2, 2] },
      { id: 'equity', side: 'equity', domain: [-2, 2] },
    ],
    layers: [],
  });
  const out = run(input);
  assert.equal(out.status, 'UNSAT');
  assert.ok(out.conflict);
  assert.deepEqual(out.conflict.formulas, ['bs']);
  assert.match(out.conflict.explanation, /bs/);
  assert.match(out.conflict.explanation, /借贷/);
  assert.equal(out.period, null);
  assert.equal(out.entry, null);
});

test('回溯预算到顶返回 PENDING 而非 UNSAT', () => {
  const input = baseInput({ budget: 1 });
  const out = run(input);
  assert.equal(out.status, 'PENDING');
  assert.equal(out.conflict, null);
  assert.ok(out.nodes > out.budget);
  assert.deepEqual(out.layers.map((l) => l.status), ['HELD', 'HELD']);
});

test('验收: ≤3 项目 2 期间的枚举对照（求解器 vs 暴力枚举）', () => {
  // 确定性伪随机
  let seed = 20261003;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];

  for (let iter = 0; iter < 300; iter++) {
    const n = 2 + Math.floor(rand() * 2); // 2..3 个项目
    const items = [];
    for (let i = 0; i < n; i++) {
      const lo = -3 + Math.floor(rand() * 4); // -3..0
      const hi = lo + Math.floor(rand() * 4); // lo..lo+3
      items.push({
        id: `it${i}`,
        side: pick(['asset', 'liability', 'equity']),
        domain: [lo, hi],
        restatement: rand() < 0.5,
      });
    }
    const balances = {};
    for (const it of items) balances[it.id] = -8 + Math.floor(rand() * 17);
    const periods = [
      { id: 'A', status: pick(['open', 'closed']) },
      { id: 'B', status: pick(['open', 'closed']) },
    ];
    const split = 1 + Math.floor(rand() * (n - 1));
    const formulas = [
      {
        id: 'f0',
        lhs: items.slice(0, split).map((it) => it.id),
        rhs: items.slice(split).map((it) => it.id),
      },
    ];
    const input = { items, balances, periods, formulas, layers: [], budget: 1000000 };

    const model = validate(JSON.parse(JSON.stringify(input)));
    const brute = bruteForce(model);
    const out = run(JSON.parse(JSON.stringify(input)));

    assert.equal(
      out.status === 'OK' || out.status === 'ROLLED_BACK',
      brute.sat,
      `第 ${iter} 例求解器与枚举结论不一致: ${JSON.stringify(input)}`,
    );

    if (out.status === 'OK') {
      // 解本身必须合法
      const period = periods.find((p) => p.id === out.period);
      const sum = out.entry.lines.reduce((s, l) => s + l.amount, 0);
      assert.equal(sum, 0, '凭证借贷必须配对');
      for (const line of out.entry.lines) {
        const item = items.find((it) => it.id === line.item);
        if (period.status === 'closed') assert.equal(item.restatement, true);
        assert.ok(line.amount >= item.domain[0] && line.amount <= item.domain[1]);
      }
      const bal = Object.assign({}, balances);
      for (const line of out.entry.lines) bal[line.item] += line.amount;
      const lhs = formulas[0].lhs.reduce((s, id) => s + bal[id], 0);
      const rhs = formulas[0].rhs.reduce((s, id) => s + bal[id], 0);
      assert.equal(lhs, rhs, '勾稽公式必须配平');
    }
  }
});
