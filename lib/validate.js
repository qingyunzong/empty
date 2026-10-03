'use strict';

class InputError extends Error {}

const SIDES = new Set(['asset', 'liability', 'equity']);
const PERIOD_STATUS = new Set(['open', 'closed']);

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function asInt(v, what) {
  if (typeof v !== 'number' || !Number.isInteger(v)) {
    throw new InputError(`${what} 必须为整数，得到 ${JSON.stringify(v)}`);
  }
  return v;
}

function asId(v, what) {
  if (typeof v !== 'string' || v.length === 0) {
    throw new InputError(`${what} 必须为非空字符串`);
  }
  return v;
}

function uniquePush(seen, id, what) {
  if (seen.has(id)) throw new InputError(`${what} 重复定义: ${id}`);
  seen.add(id);
}

// 将原始 JSON 校验并规整为内部模型；任何非法引用都抛 InputError（CLI 退出码 1）。
function validate(raw) {
  if (!isPlainObject(raw)) throw new InputError('输入必须是 JSON 对象');

  // ---- 报表项目 ----
  if (!Array.isArray(raw.items) || raw.items.length === 0) {
    throw new InputError('items 必须是非空数组');
  }
  const itemIds = new Set();
  const items = raw.items.map((it, i) => {
    if (!isPlainObject(it)) throw new InputError(`items[${i}] 必须是对象`);
    const id = asId(it.id, `items[${i}].id`);
    uniquePush(itemIds, id, '报表项目');
    if (!SIDES.has(it.side)) {
      throw new InputError(`报表项目 ${id} 的 side 非法: ${JSON.stringify(it.side)}`);
    }
    if (!Array.isArray(it.domain) || it.domain.length !== 2) {
      throw new InputError(`报表项目 ${id} 的 domain 必须是 [下界, 上界]`);
    }
    const lo = asInt(it.domain[0], `报表项目 ${id} 的 domain 下界`);
    const hi = asInt(it.domain[1], `报表项目 ${id} 的 domain 上界`);
    if (lo > hi) throw new InputError(`报表项目 ${id} 的 domain 下界大于上界`);
    return { id, side: it.side, lo, hi, restatement: it.restatement === true };
  });

  // ---- 期初余额 ----
  const balances = new Map();
  if (raw.balances !== undefined && !isPlainObject(raw.balances)) {
    throw new InputError('balances 必须是对象');
  }
  for (const it of items) balances.set(it.id, 0);
  if (raw.balances) {
    for (const [k, v] of Object.entries(raw.balances)) {
      if (!itemIds.has(k)) throw new InputError(`balances 引用了不存在的报表项目 ${k}`);
      balances.set(k, asInt(v, `balances.${k}`));
    }
  }

  // ---- 期间 ----
  if (!Array.isArray(raw.periods) || raw.periods.length === 0) {
    throw new InputError('periods 必须是非空数组');
  }
  const periodIds = new Set();
  const periods = raw.periods.map((p, i) => {
    if (!isPlainObject(p)) throw new InputError(`periods[${i}] 必须是对象`);
    const id = asId(p.id, `periods[${i}].id`);
    uniquePush(periodIds, id, '期间');
    if (!PERIOD_STATUS.has(p.status)) {
      throw new InputError(`期间 ${id} 的状态非法: ${JSON.stringify(p.status)}`);
    }
    return { id, status: p.status };
  });

  // ---- 勾稽公式 ----
  if (!Array.isArray(raw.formulas) || raw.formulas.length === 0) {
    throw new InputError('formulas 必须是非空数组');
  }
  const formulaIds = new Set();
  const formulas = raw.formulas.map((f, i) => {
    if (!isPlainObject(f)) throw new InputError(`formulas[${i}] 必须是对象`);
    const id = asId(f.id, `formulas[${i}].id`);
    uniquePush(formulaIds, id, '勾稽公式');
    const lhs = f.lhs ?? [];
    const rhs = f.rhs ?? [];
    if (!Array.isArray(lhs) || !Array.isArray(rhs)) {
      throw new InputError(`公式 ${id} 的 lhs/rhs 必须是数组`);
    }
    if (lhs.length === 0 && rhs.length === 0) {
      throw new InputError(`公式 ${id} 的 lhs 与 rhs 不能同时为空`);
    }
    const terms = [];
    for (const x of lhs) {
      asId(x, `公式 ${id} 的 lhs 项`);
      if (!itemIds.has(x)) throw new InputError(`公式 ${id} 引用了不存在的报表项目 ${x}`);
      terms.push({ item: x, coeff: 1 });
    }
    for (const x of rhs) {
      asId(x, `公式 ${id} 的 rhs 项`);
      if (!itemIds.has(x)) throw new InputError(`公式 ${id} 引用了不存在的报表项目 ${x}`);
      terms.push({ item: x, coeff: -1 });
    }
    const constant = f.constant === undefined ? 0 : asInt(f.constant, `公式 ${id} 的 constant`);
    return { id, terms, constant };
  });

  // ---- 发布层（数组顺序 = 由低到高，先发布低层）----
  const layers = (raw.layers ?? []).map((l, i) => {
    if (!isPlainObject(l)) throw new InputError(`layers[${i}] 必须是对象`);
    const id = asId(l.id, `layers[${i}].id`);
    const formulaRefs = l.formulas ?? [];
    if (!Array.isArray(formulaRefs)) throw new InputError(`发布层 ${id} 的 formulas 必须是数组`);
    for (const fid of formulaRefs) {
      if (!formulaIds.has(fid)) {
        throw new InputError(`发布层 ${id} 引用了不存在的勾稽公式 ${fid}`);
      }
    }
    const reserve = l.reserve === undefined ? 0 : asInt(l.reserve, `发布层 ${id} 的 reserve`);
    if (reserve < 0) throw new InputError(`发布层 ${id} 的 reserve 不能为负`);
    let maxAmount = null;
    if (l.maxAmount !== undefined && l.maxAmount !== null) {
      maxAmount = asInt(l.maxAmount, `发布层 ${id} 的 maxAmount`);
      if (maxAmount < 0) throw new InputError(`发布层 ${id} 的 maxAmount 不能为负`);
    }
    return { id, formulaIds: formulaRefs.slice(), reserve, maxAmount };
  });

  // ---- 求解约束 ----
  const constraints = raw.constraints ?? {};
  if (!isPlainObject(constraints)) throw new InputError('constraints 必须是对象');
  let forcedPeriod = null;
  if (constraints.period !== undefined && constraints.period !== null) {
    asId(constraints.period, 'constraints.period');
    if (!periodIds.has(constraints.period)) {
      throw new InputError(`目标期间非法: ${constraints.period} 不存在于 periods`);
    }
    forcedPeriod = constraints.period;
  }
  let enforcedFormulaIds = formulas.map((f) => f.id);
  if (constraints.formulas !== undefined && constraints.formulas !== null) {
    if (!Array.isArray(constraints.formulas)) {
      throw new InputError('constraints.formulas 必须是数组');
    }
    for (const fid of constraints.formulas) {
      if (!formulaIds.has(fid)) {
        throw new InputError(`constraints 引用了不存在的勾稽公式 ${fid}`);
      }
    }
    enforcedFormulaIds = constraints.formulas.slice();
  }

  const budget = raw.budget === undefined ? 100000 : asInt(raw.budget, 'budget');
  if (budget < 0) throw new InputError('budget 不能为负');

  return {
    items,
    itemIndex: new Map(items.map((it, i) => [it.id, i])),
    balances,
    periods,
    periodIndex: new Map(periods.map((p, i) => [p.id, i])),
    formulas,
    formulaIndex: new Map(formulas.map((f, i) => [f.id, i])),
    layers,
    forcedPeriod,
    enforcedFormulaIds,
    budget,
  };
}

module.exports = { validate, InputError };
