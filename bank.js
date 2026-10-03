'use strict';
// 银行风控额度引擎：冻结区间合并/切割、分类与总限额扣款、审计链。
//
// 模型约定（轴模型）：
// - 额度轴为 [0, totalLimit]。扣款从左侧累计占用，spend 指针为已扣总额。
// - 冻结是轴上的显式区间 [start, end]，重叠或相接时合并；解冻只能完整切割已被冻结覆盖的区间。
// - 扣款 amount 需要轴段 [spent, spent+amount]：不与任何冻结区间相交（显式冻结），
//   且分类已用 + amount <= 分类限额，且 spent + amount <= totalLimit。
//   检查优先级：显式冻结 > 分类限额 > 总限额，首个被违反的约束即失败原因。
// - 可用额 available = max(0, min(首个阻挡冻结起点, totalLimit) - spent)。
// - 同一 ts 的请求按 id 字典序处理；重复 id 记 E_DUP；失败请求无副作用但写审计。

const crypto = require('node:crypto');

const E_RANGE = 'E_RANGE';
const E_LIMIT = 'E_LIMIT';
const E_DUP = 'E_DUP';

const RANGE_RE = /^(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)$/;

function parseRange(scope) {
  if (typeof scope !== 'string') return null;
  const m = RANGE_RE.exec(scope);
  if (!m) return null;
  return [Number(m[1]), Number(m[2])];
}

// ---- 区间集合操作（输入为已排序、互不相交且不相接的 [[s,e],...]） ----

function addInterval(intervals, s, e) {
  const result = [];
  let ns = s;
  let ne = e;
  let inserted = false;
  for (const [a, b] of intervals) {
    if (b < ns) {
      result.push([a, b]);
    } else if (a > ne) {
      if (!inserted) { result.push([ns, ne]); inserted = true; }
      result.push([a, b]);
    } else {
      ns = Math.min(ns, a);
      ne = Math.max(ne, b);
    }
  }
  if (!inserted) result.push([ns, ne]);
  return result;
}

function cutInterval(intervals, s, e) {
  const result = [];
  for (const [a, b] of intervals) {
    if (b <= s || a >= e) { result.push([a, b]); continue; }
    if (a < s) result.push([a, s]);
    if (b > e) result.push([e, b]);
  }
  return result;
}

function isCovered(intervals, s, e) {
  let cursor = s;
  for (const [a, b] of intervals) {
    if (b <= cursor) continue;
    if (a > cursor) return false;
    cursor = Math.max(cursor, b);
    if (cursor >= e) return true;
  }
  return cursor >= e;
}

function intersects(intervals, s, e) {
  return intervals.some(([a, b]) => a < e && b > s);
}

function totalLength(intervals) {
  return intervals.reduce((acc, [a, b]) => acc + (b - a), 0);
}

// 首个满足 b > from 的区间起点；无则 Infinity
function blockingStart(intervals, from) {
  let best = Infinity;
  for (const [a, b] of intervals) {
    if (b > from && a < best) best = a;
  }
  return best;
}

// ---- 审计链 ----

const GENESIS = '0'.repeat(64);

function auditHash(prevHash, entry) {
  return crypto.createHash('sha256')
    .update(prevHash + '|' + JSON.stringify(entry))
    .digest('hex');
}

// ---- 账户状态 ----

function createState(config) {
  const totalLimit = config && Number.isFinite(config.totalLimit) ? config.totalLimit : 1000;
  const categoryLimits = (config && config.categoryLimits) || {};
  return {
    totalLimit,
    categoryLimits: { ...categoryLimits },
    spent: 0,
    spentByCat: {},
    frozen: [],
    seenIds: new Set(),
    audit: [],
  };
}

function availableOf(state) {
  const blocking = blockingStart(state.frozen, state.spent);
  return Math.max(0, Math.min(blocking, state.totalLimit) - state.spent);
}

function snapshot(state) {
  return {
    available: availableOf(state),
    spent: state.spent,
    spentByCat: { ...state.spentByCat },
    frozen: state.frozen.map(([a, b]) => [a, b]),
    frozenTotal: totalLength(state.frozen),
  };
}

function fail(code, reason) {
  return { ok: false, code, reason };
}

// 处理单条请求；成功时原地修改 state，失败无副作用。返回步骤记录（不含审计字段）。
function processOp(state, op) {
  if (state.seenIds.has(op.id)) {
    return fail(E_DUP, `duplicate request id '${op.id}'`);
  }
  state.seenIds.add(op.id);

  if (op.op === 'freeze' || op.op === 'unfreeze') {
    const range = parseRange(op.scope);
    if (!range) return fail(E_RANGE, `scope '${op.scope}' is not a 'start-end' range`);
    const [s, e] = range;
    if (!(s < e)) return fail(E_RANGE, `invalid range [${s}, ${e}]`);
    if (s < 0 || e > state.totalLimit) {
      return fail(E_RANGE, `range [${s}, ${e}] outside [0, ${state.totalLimit}]`);
    }
    if (op.amount !== e - s) {
      return fail(E_RANGE, `amount ${op.amount} != range length ${e - s}`);
    }
    if (op.op === 'freeze') {
      state.frozen = addInterval(state.frozen, s, e);
    } else {
      if (!isCovered(state.frozen, s, e)) {
        return fail(E_RANGE, `range [${s}, ${e}] is not fully frozen`);
      }
      state.frozen = cutInterval(state.frozen, s, e);
    }
    return { ok: true, code: null, reason: null };
  }

  if (op.op === 'debit') {
    if (!(typeof op.amount === 'number' && op.amount > 0)) {
      return fail(E_RANGE, `debit amount must be positive, got ${op.amount}`);
    }
    const category = op.scope;
    // 优先级 1：显式冻结
    if (intersects(state.frozen, state.spent, state.spent + op.amount)) {
      return fail(E_LIMIT, `explicit-freeze: segment [${state.spent}, ${state.spent + op.amount}] intersects frozen interval`);
    }
    // 优先级 2：分类限额
    const catLimit = Object.prototype.hasOwnProperty.call(state.categoryLimits, category)
      ? state.categoryLimits[category]
      : Infinity;
    const catSpent = state.spentByCat[category] || 0;
    if (catSpent + op.amount > catLimit) {
      return fail(E_LIMIT, `category-limit: '${category}' ${catSpent}+${op.amount} > ${catLimit}`);
    }
    // 优先级 3：总限额
    if (state.spent + op.amount > state.totalLimit) {
      return fail(E_LIMIT, `total-limit: ${state.spent}+${op.amount} > ${state.totalLimit}`);
    }
    state.spent += op.amount;
    state.spentByCat[category] = catSpent + op.amount;
    return { ok: true, code: null, reason: null };
  }

  return fail(E_RANGE, `unknown op '${op.op}'`);
}

// 应用整批请求：先按 (ts, id) 排序，再逐条处理并写审计链。
function applyOps(config, ops) {
  const state = createState(config);
  const sorted = [...ops].sort((x, y) => (x.ts - y.ts) || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  const steps = [];
  sorted.forEach((op, index) => {
    const verdict = processOp(state, op);
    const snap = snapshot(state);
    const entry = {
      index, ts: op.ts, id: op.id, op: op.op, scope: op.scope, amount: op.amount,
      ok: verdict.ok, code: verdict.code, reason: verdict.reason,
      available: snap.available, spent: snap.spent, frozen: snap.frozen, frozenTotal: snap.frozenTotal,
    };
    const prevHash = state.audit.length ? state.audit[state.audit.length - 1] : GENESIS;
    const hash = auditHash(prevHash, entry);
    state.audit.push(hash);
    steps.push({ ...entry, audit: hash });
  });
  const finalSnap = snapshot(state);
  return {
    account: { totalLimit: state.totalLimit, categoryLimits: state.categoryLimits },
    steps,
    final: { ...finalSnap, spentByCat: finalSnap.spentByCat },
    auditChain: [...state.audit],
    auditValid: verifyAuditChain(steps),
  };
}

function verifyAuditChain(steps) {
  let prev = GENESIS;
  for (const step of steps) {
    const { audit, ...entry } = step;
    const expect = auditHash(prev, entry);
    if (expect !== audit) return false;
    prev = audit;
  }
  return true;
}

module.exports = {
  E_RANGE, E_LIMIT, E_DUP, GENESIS,
  addInterval, cutInterval, isCovered, intersects, totalLength, blockingStart,
  parseRange, createState, processOp, applyOps, verifyAuditChain, auditHash,
};
