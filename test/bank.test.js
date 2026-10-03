'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  E_RANGE, E_LIMIT, E_DUP,
  applyOps, verifyAuditChain, addInterval, cutInterval, isCovered, totalLength,
} = require('../bank');

const CFG = { totalLimit: 100, categoryLimits: { food: 50 } };
const frz = (ts, id, s, e) => ({ ts, id, op: 'freeze', amount: e - s, scope: `${s}-${e}` });
const unz = (ts, id, s, e) => ({ ts, id, op: 'unfreeze', amount: e - s, scope: `${s}-${e}` });
const dbt = (ts, id, amount, scope) => ({ ts, id, op: 'debit', amount, scope });

// 验收 1：重叠冻结合并与解冻切割
test('freeze merge + unfreeze cut', () => {
  const r = applyOps({ totalLimit: 100 }, [
    frz(1, 'f1', 10, 40),
    frz(2, 'f2', 30, 60),   // 与 [10,40] 重叠 -> [10,60]
    frz(3, 'f3', 70, 80),   // 不相交 -> 独立区间
    unz(4, 'u1', 20, 50),   // 从中间切割 [10,60] -> [10,20],[50,60]
    unz(5, 'u2', 50, 60),   // 整段解冻
    unz(6, 'u3', 5, 15),    // [5,10] 未冻结 -> E_RANGE
    unz(7, 'u4', 10, 20),   // 完整覆盖 -> 成功
    frz(8, 'f4', 90, 110),  // 超出总限额 -> E_RANGE
  ]);
  const st = r.steps;
  assert.equal(st[0].ok, true);
  assert.deepEqual(st[1].frozen, [[10, 60]]);
  assert.deepEqual(st[2].frozen, [[10, 60], [70, 80]]);
  assert.deepEqual(st[3].frozen, [[10, 20], [50, 60], [70, 80]]);
  assert.deepEqual(st[4].frozen, [[10, 20], [70, 80]]);
  assert.equal(st[5].ok, false);
  assert.equal(st[5].code, E_RANGE);
  assert.deepEqual(st[6].frozen, [[70, 80]]);
  assert.equal(st[7].ok, false);
  assert.equal(st[7].code, E_RANGE);
  // 失败请求无副作用
  assert.deepEqual(st[7].frozen, st[6].frozen);
  // amount 与区间长度不一致 -> E_RANGE
  const bad = applyOps({ totalLimit: 100 }, [{ ts: 1, id: 'x', op: 'freeze', amount: 5, scope: '10-20' }]);
  assert.equal(bad.steps[0].code, E_RANGE);
});

// 验收 2：分类限额失败但总限额足够；优先级 显式冻结 > 分类限额 > 总限额
test('debit priority: explicit-freeze > category-limit > total-limit', () => {
  const r = applyOps(CFG, [
    dbt(1, 'd1', 40, 'food'),   // ok: food 40/50
    dbt(2, 'd2', 20, 'food'),   // 分类超限(60>50) 但总额(60<100)够 -> E_LIMIT category
    dbt(3, 'd3', 50, 'other'),  // 无分类限额 -> ok, spent=90
    dbt(4, 'd4', 20, 'other'),  // 总限额超限(110>100) -> E_LIMIT total
  ]);
  assert.equal(r.steps[0].ok, true);
  assert.equal(r.steps[1].ok, false);
  assert.equal(r.steps[1].code, E_LIMIT);
  assert.match(r.steps[1].reason, /^category-limit/);
  assert.equal(r.steps[2].ok, true);
  assert.equal(r.steps[3].code, E_LIMIT);
  assert.match(r.steps[3].reason, /^total-limit/);
  assert.equal(r.steps[3].spent, 90); // 失败无副作用

  // 显式冻结优先于分类限额：分类与总额都够，但轴段被冻结挡住
  const r2 = applyOps(CFG, [
    frz(1, 'f1', 0, 30),
    dbt(2, 'd1', 10, 'food'),
  ]);
  assert.equal(r2.steps[1].code, E_LIMIT);
  assert.match(r2.steps[1].reason, /^explicit-freeze/);
  assert.equal(r2.steps[1].available, 0);
  // 冻结在 spend 指针之后：可用额被截断
  const r3 = applyOps(CFG, [frz(1, 'f1', 50, 60), dbt(2, 'd1', 60, 'other')]);
  assert.match(r3.steps[1].reason, /^explicit-freeze/);
  assert.equal(r3.steps[0].available, 50);
});

// 验收 3：同刻并列扣款按 id 字典序决定唯一成功
test('same-ts debits: lexicographic id decides the unique winner', () => {
  const mk = () => [
    dbt(7, 'req-c', 60, 'other'),
    dbt(7, 'req-a', 60, 'other'),
    dbt(7, 'req-b', 60, 'other'),
  ];
  const r = applyOps({ totalLimit: 100 }, mk());
  assert.deepEqual(r.steps.map((s) => s.id), ['req-a', 'req-b', 'req-c']);
  assert.deepEqual(r.steps.map((s) => s.ok), [true, false, false]);
  assert.equal(r.steps[1].code, E_LIMIT);
  assert.match(r.steps[1].reason, /^total-limit/);
  assert.equal(r.final.spent, 60);
  // 输入顺序打乱，结果不变
  const shuffled = mk().reverse();
  const r2 = applyOps({ totalLimit: 100 }, shuffled);
  assert.deepEqual(r2.steps.map((s) => s.id), ['req-a', 'req-b', 'req-c']);
  assert.deepEqual(r2.steps.map((s) => s.ok), [true, false, false]);
});

// E_DUP：重复 id 无副作用但写审计
test('duplicate id -> E_DUP, no side effect, audited', () => {
  const r = applyOps(CFG, [dbt(1, 'dup', 10, 'food'), dbt(2, 'dup', 10, 'food')]);
  assert.equal(r.steps[0].ok, true);
  assert.equal(r.steps[1].code, E_DUP);
  assert.equal(r.final.spent, 10);
  assert.equal(r.auditChain.length, 2);
  assert.equal(r.auditValid, true);
});

// 审计链可独立验证，且篡改可检测
test('audit chain verifies and detects tampering', () => {
  const r = applyOps(CFG, [dbt(1, 'a', 10, 'food'), frz(2, 'b', 5, 8), dbt(3, 'c', 1, 'food')]);
  assert.equal(verifyAuditChain(r.steps), true);
  const tampered = r.steps.map((s) => ({ ...s }));
  tampered[1].amount = 999;
  assert.equal(verifyAuditChain(tampered), false);
});

// 区间原语单元测试
test('interval primitives', () => {
  let iv = [];
  iv = addInterval(iv, 10, 20);
  iv = addInterval(iv, 30, 40);
  iv = addInterval(iv, 15, 35); // 桥接合并
  assert.deepEqual(iv, [[10, 40]]);
  iv = addInterval(iv, 40, 50); // 相接也合并
  assert.deepEqual(iv, [[10, 50]]);
  assert.equal(isCovered(iv, 12, 48), true);
  assert.equal(isCovered(iv, 12, 51), false);
  iv = cutInterval(iv, 20, 30);
  assert.deepEqual(iv, [[10, 20], [30, 50]]);
  assert.equal(totalLength(iv), 30);
});

// 验收 4：随机小状态(<=100) 与暴力区间维护对照
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 暴力参考实现：用单位槽位数组维护冻结，逐步扫描得到合并区间
function bruteForce(totalLimit, ops) {
  const slots = new Array(totalLimit).fill(false);
  const seen = new Set();
  const spentByCat = {};
  let spent = 0;
  const sorted = [...ops].sort((x, y) => (x.ts - y.ts) || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  return sorted.map((op) => {
    const mergedOf = () => {
      const out = [];
      let i = 0;
      while (i < totalLimit) {
        if (!slots[i]) { i++; continue; }
        let j = i;
        while (j + 1 < totalLimit && slots[j + 1]) j++;
        out.push([i, j + 1]);
        i = j + 1;
      }
      return out;
    };
    let ok = true, code = null;
    if (seen.has(op.id)) { ok = false; code = E_DUP; }
    else {
      seen.add(op.id);
      if (op.op === 'freeze' || op.op === 'unfreeze') {
        const [s, e] = op.scope.split('-').map(Number);
        if (!(s < e) || s < 0 || e > totalLimit || op.amount !== e - s) { ok = false; code = E_RANGE; }
        else if (op.op === 'freeze') { for (let i = s; i < e; i++) slots[i] = true; }
        else {
          if (!slots.slice(s, e).every(Boolean)) { ok = false; code = E_RANGE; }
          else for (let i = s; i < e; i++) slots[i] = false;
        }
      } else {
        if (!(op.amount > 0)) { ok = false; code = E_RANGE; }
        else if (slots.slice(spent, spent + op.amount).some(Boolean)) { ok = false; code = E_LIMIT; }
        else if ((spentByCat[op.scope] || 0) + op.amount > (op.catLimit ?? Infinity)) { ok = false; code = E_LIMIT; }
        else if (spent + op.amount > totalLimit) { ok = false; code = E_LIMIT; }
        else { spent += op.amount; spentByCat[op.scope] = (spentByCat[op.scope] || 0) + op.amount; }
      }
    }
    const frozen = mergedOf();
    let blocking = Infinity;
    for (const [a, b] of frozen) if (b > spent && a < blocking) blocking = a;
    return { ok, code, frozen, available: Math.max(0, Math.min(blocking, totalLimit) - spent), spent };
  });
}

test('random small states (<=100) match brute-force interval maintenance', () => {
  const rand = mulberry32(20261003);
  const cats = ['food', 'travel', 'other'];
  for (let trial = 0; trial < 100; trial++) {
    const totalLimit = 10 + Math.floor(rand() * 91); // 10..100
    const categoryLimits = { food: 5 + Math.floor(rand() * totalLimit) };
    const nOps = 1 + Math.floor(rand() * 40);
    const ops = [];
    for (let k = 0; k < nOps; k++) {
      const kind = rand();
      const ts = Math.floor(rand() * 5); // 小 ts 域制造同刻冲突
      const id = `t${trial}-k${Math.floor(rand() * (nOps / 2))}`; // 故意制造重复 id
      if (kind < 0.35) {
        const s = Math.floor(rand() * (totalLimit + 5));
        const e = s + Math.floor(rand() * 15);
        ops.push(frz(ts, id, s, e));
      } else if (kind < 0.6) {
        const s = Math.floor(rand() * (totalLimit + 5));
        const e = s + Math.floor(rand() * 15);
        ops.push(unz(ts, id, s, e));
      } else {
        ops.push(dbt(ts, id, 1 + Math.floor(rand() * 30), cats[Math.floor(rand() * cats.length)]));
      }
    }
    const got = applyOps({ totalLimit, categoryLimits }, ops);
    const ref = bruteForce(totalLimit, ops.map((o) => ({ ...o, catLimit: o.op === 'debit' ? categoryLimits[o.scope] : undefined })));
    assert.equal(got.steps.length, ref.length);
    for (let i = 0; i < ref.length; i++) {
      const g = got.steps[i];
      const x = ref[i];
      assert.equal(g.ok, x.ok, `trial ${trial} step ${i} ok (${JSON.stringify(g)})`);
      if (!x.ok) assert.equal(g.code, x.code, `trial ${trial} step ${i} code`);
      assert.deepEqual(g.frozen, x.frozen, `trial ${trial} step ${i} frozen`);
      assert.equal(g.available, x.available, `trial ${trial} step ${i} available`);
      assert.equal(g.spent, x.spent, `trial ${trial} step ${i} spent`);
    }
    assert.equal(got.auditValid, true);
  }
});

// CLI 集成：全成功退出 0；有失败写 stderr 且退出 1；坏输入退出 1
test('cli: exit codes, stderr, report file', () => {
  const { run } = require('../cli');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bank-'));
  const invoke = (inPath, outPath) => {
    const errs = [];
    const code = run(['node', 'cli.js', inPath, outPath], (m) => errs.push(m));
    return { code, stderr: errs.join('\n') };
  };

  const okOps = path.join(dir, 'ok.jsonl');
  const okOut = path.join(dir, 'ok.json');
  fs.writeFileSync(okOps, [
    JSON.stringify({ op: 'config', totalLimit: 100, categoryLimits: { food: 50 } }),
    JSON.stringify(dbt(1, 'a', 30, 'food')),
    JSON.stringify(frz(2, 'b', 40, 60)),
  ].join('\n') + '\n');
  const r1 = invoke(okOps, okOut);
  assert.equal(r1.code, 0, r1.stderr);
  const report = JSON.parse(fs.readFileSync(okOut, 'utf8'));
  assert.equal(report.steps.length, 2);
  assert.equal(report.auditValid, true);
  assert.equal(report.final.available, 10); // spent=30, 冻结 [40,60] 阻挡 -> min(40,100)-30

  const badOps = path.join(dir, 'bad.jsonl');
  const badOut = path.join(dir, 'bad.json');
  fs.writeFileSync(badOps, [
    JSON.stringify({ op: 'config', totalLimit: 100 }),
    JSON.stringify(dbt(1, 'x', 80, 'c')),
    JSON.stringify(dbt(2, 'y', 80, 'c')),
  ].join('\n') + '\n');
  const r2 = invoke(badOps, badOut);
  assert.equal(r2.code, 1);
  assert.match(r2.stderr, /E_LIMIT id=y/);
  const report2 = JSON.parse(fs.readFileSync(badOut, 'utf8'));
  assert.deepEqual(report2.steps.map((s) => s.ok), [true, false]);

  const r3 = invoke(path.join(dir, 'missing.jsonl'), badOut);
  assert.equal(r3.code, 1);
  assert.match(r3.stderr, /E_IO/);

  const parseOps = path.join(dir, 'parse.jsonl');
  fs.writeFileSync(parseOps, '{not json}\n');
  const r4 = invoke(parseOps, badOut);
  assert.equal(r4.code, 1);
  assert.match(r4.stderr, /E_PARSE/);

  const dupCfg = path.join(dir, 'dupcfg.jsonl');
  fs.writeFileSync(dupCfg, JSON.stringify({ op: 'config', totalLimit: 10 }) + '\n' + JSON.stringify({ op: 'config', totalLimit: 20 }) + '\n');
  const r5 = invoke(dupCfg, badOut);
  assert.equal(r5.code, 1);
  assert.match(r5.stderr, /duplicate config/);
});
