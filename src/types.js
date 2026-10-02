// 静态类型检查：功率(kW)/能量(kWh)/时长(min)/时刻(15 分钟槽对齐)，模板词法作用域
import { LangError } from './lexer.js';

export class TypeCheckError extends LangError {
  constructor(message, line, col) {
    super(message, line, col, 'TypeError');
  }
}

export const SLOTS_PER_DAY = 96;
export const SLOT_MINUTES = 15;

function evalConst(expr, what) {
  switch (expr.kind) {
    case 'num':
      return expr.value;
    case 'neg':
      return -evalConst(expr.expr, what);
    case 'var':
      throw new TypeCheckError(`${what}中不允许使用变量 "${expr.name}"`, expr.line, expr.col);
    case 'bin': {
      const l = evalConst(expr.left, what);
      const r = evalConst(expr.right, what);
      switch (expr.op) {
        case '+': return l + r;
        case '-': return l - r;
        case '*': return l * r;
        case '/':
          if (r === 0) throw new TypeCheckError('除以零', expr.line, expr.col);
          return l / r;
        default:
          throw new TypeCheckError(`未知运算符 "${expr.op}"`, expr.line, expr.col);
      }
    }
    default:
      throw new TypeCheckError('无效表达式', expr.line, expr.col);
  }
}

function timeToSlot(t) {
  const [hh, mm] = t.text.split(':').map(Number);
  if (mm % SLOT_MINUTES !== 0) {
    throw new TypeCheckError(`时刻 "${t.text}" 未对齐 15 分钟槽`, t.line, t.col);
  }
  return hh * 4 + mm / SLOT_MINUTES;
}

function checkUnit(f, want) {
  if (!f.unit) {
    throw new TypeCheckError(`字段 "${f.field}" 缺少单位 ${want}`, f.line, f.col);
  }
  if (f.unit !== want) {
    throw new TypeCheckError(`字段 "${f.field}" 单位应为 ${want}，实际为 ${f.unit}`, f.line, f.col);
  }
}

function checkNoUnit(v, what) {
  if (v.unit) {
    throw new TypeCheckError(`${what} 不应带单位 ${v.unit}`, v.line, v.col);
  }
}

function checkObjectiveVars(expr) {
  switch (expr.kind) {
    case 'num':
      return;
    case 'neg':
      checkObjectiveVars(expr.expr);
      return;
    case 'var':
      if (expr.name !== 'cost' && expr.name !== 'peak' && expr.name !== 'carbon') {
        throw new TypeCheckError(`目标表达式中未知变量 "${expr.name}"`, expr.line, expr.col);
      }
      return;
    case 'bin':
      checkObjectiveVars(expr.left);
      checkObjectiveVars(expr.right);
      return;
    default:
      throw new TypeCheckError('无效目标表达式', expr.line, expr.col);
  }
}

export function check(site) {
  // 模板表：词法作用域 —— 父模板必须在子模板之前定义，子模板字段遮蔽父模板
  const templates = new Map();
  for (const tpl of site.templates) {
    if (templates.has(tpl.name)) {
      throw new TypeCheckError(`模板 "${tpl.name}" 重复定义`, tpl.line, tpl.col);
    }
    if (tpl.parent !== null && !templates.has(tpl.parent)) {
      throw new TypeCheckError(
        `模板 "${tpl.name}" 的父模板 "${tpl.parent}" 未在此之前定义`, tpl.line, tpl.col);
    }
    templates.set(tpl.name, tpl);
  }

  const mergedFields = (bodies) => {
    const map = new Map();
    for (const { fields, owner } of bodies) {
      const local = new Set();
      for (const f of fields) {
        if (local.has(f.field)) {
          throw new TypeCheckError(`字段 "${f.field}" 在 ${owner} 中重复定义`, f.line, f.col);
        }
        local.add(f.field);
        map.set(f.field, f); // 内层作用域遮蔽外层
      }
    }
    return map;
  };

  const FIELD_UNITS = { power: 'kW', duration: 'min', energy: 'kWh' };
  // 模板体在定义处即做静态校验（重复字段、单位、常量可求值、窗口合法）
  const validateBody = (fields, owner) => {
    mergedFields([{ fields, owner }]);
    for (const f of fields) {
      if (FIELD_UNITS[f.field]) {
        checkUnit(f, FIELD_UNITS[f.field]);
        evalConst(f.expr, f.field);
      } else if (f.field === 'maxInterruptions') {
        if (f.unit) throw new TypeCheckError('maxInterruptions 不应带单位', f.line, f.col);
        const v = evalConst(f.expr, 'maxInterruptions');
        if (!Number.isInteger(v) || v < 0) {
          throw new TypeCheckError('maxInterruptions 必须是非负整数', f.line, f.col);
        }
      } else if (f.field === 'window') {
        const a = timeToSlot(f.range.from);
        const b = timeToSlot(f.range.to);
        if (!(a < b)) throw new TypeCheckError('窗口起点必须早于终点', f.line, f.col);
      }
    }
  };
  for (const tpl of templates.values()) {
    validateBody(tpl.fields, `模板 "${tpl.name}"`);
  }

  const templateChain = (tpl) => {
    const chain = [];
    let cur = tpl;
    while (cur) {
      chain.unshift(cur);
      cur = cur.parent ? templates.get(cur.parent) : null;
    }
    return chain;
  };

  // 任务
  const tasks = [];
  const taskIds = new Set();
  for (const task of site.tasks) {
    if (taskIds.has(task.id)) {
      throw new TypeCheckError(`任务 "${task.id}" 重复定义`, task.line, task.col);
    }
    taskIds.add(task.id);
    const tpl = templates.get(task.template);
    if (!tpl) {
      throw new TypeCheckError(`任务 "${task.id}" 引用了未定义的模板 "${task.template}"`, task.line, task.col);
    }
    const bodies = templateChain(tpl).map((t) => ({ fields: t.fields, owner: `模板 "${t.name}"` }));
    bodies.push({ fields: task.fields, owner: `任务 "${task.id}"` });
    const fields = mergedFields(bodies);

    const powerF = fields.get('power');
    if (!powerF) throw new TypeCheckError(`任务 "${task.id}" 缺少 power`, task.line, task.col);
    checkUnit(powerF, 'kW');
    const power = evalConst(powerF.expr, 'power');
    if (!(power > 0)) throw new TypeCheckError('power 必须为正数', powerF.line, powerF.col);

    const winF = fields.get('window');
    if (!winF) throw new TypeCheckError(`任务 "${task.id}" 缺少 window`, task.line, task.col);
    const w0 = timeToSlot(winF.range.from);
    const w1 = timeToSlot(winF.range.to);
    if (!(w0 < w1)) throw new TypeCheckError('窗口起点必须早于终点', winF.line, winF.col);

    const durF = fields.get('duration');
    const enF = fields.get('energy');
    if (durF && enF) throw new TypeCheckError('duration 与 energy 只能二选一', enF.line, enF.col);
    if (!durF && !enF) {
      throw new TypeCheckError(`任务 "${task.id}" 缺少 duration 或 energy`, task.line, task.col);
    }
    let minutes;
    if (durF) {
      checkUnit(durF, 'min');
      minutes = evalConst(durF.expr, 'duration');
    } else {
      checkUnit(enF, 'kWh');
      const kwh = evalConst(enF.expr, 'energy');
      if (!(kwh > 0)) throw new TypeCheckError('energy 必须为正数', enF.line, enF.col);
      minutes = (kwh / power) * 60;
    }
    if (!(minutes > 0)) throw new TypeCheckError('时长必须为正数', (durF || enF).line, (durF || enF).col);
    const slotsF = minutes / SLOT_MINUTES;
    if (Math.abs(slotsF - Math.round(slotsF)) > 1e-9) {
      throw new TypeCheckError(`时长 ${minutes} 分钟未对齐 15 分钟槽`, (durF || enF).line, (durF || enF).col);
    }
    const durationSlots = Math.round(slotsF);
    if (durationSlots > w1 - w0) {
      throw new TypeCheckError(`任务 "${task.id}" 时长超出窗口`, task.line, task.col);
    }

    const intF = fields.get('interruptible');
    const interruptible = intF ? intF.value : false;
    const miF = fields.get('maxInterruptions');
    let maxInterruptions = 0;
    if (interruptible) {
      if (miF) {
        const v = evalConst(miF.expr, 'maxInterruptions');
        if (!Number.isInteger(v) || v < 0) {
          throw new TypeCheckError('maxInterruptions 必须是非负整数', miF.line, miF.col);
        }
        maxInterruptions = v;
      } else {
        maxInterruptions = 2;
      }
    }

    tasks.push({
      id: task.id,
      power,
      durationSlots,
      window: [w0, w1],
      interruptible,
      maxInterruptions,
      line: task.line,
      col: task.col,
    });
  }

  // 容量
  let capacity = Infinity;
  if (site.capacity) {
    const c = site.capacity;
    if (c.unit !== 'kW') {
      throw new TypeCheckError(`capacity 单位应为 kW${c.unit ? `，实际为 ${c.unit}` : '（缺少单位）'}`, c.line, c.col);
    }
    capacity = evalConst(c.expr, 'capacity');
    if (!(capacity > 0)) throw new TypeCheckError('capacity 必须为正数', c.line, c.col);
  }

  // 电价表 / 碳强度表
  const buildTable = (entries, what) => {
    const table = new Array(SLOTS_PER_DAY).fill(null);
    for (const e of entries) {
      checkNoUnit(e, what);
      const v = evalConst(e.expr, what);
      if (!(v >= 0)) throw new TypeCheckError(`${what} 不能为负`, e.line, e.col);
      const s0 = timeToSlot(e.from);
      const s1 = timeToSlot(e.to);
      if (!(s0 < s1)) throw new TypeCheckError('时段起点必须早于终点', e.line, e.col);
      for (let s = s0; s < s1; s += 1) {
        if (table[s] !== null) throw new TypeCheckError(`${what}时段在槽 ${s} 处重叠`, e.line, e.col);
        table[s] = v;
      }
    }
    return table.map((v) => (v === null ? 0 : v));
  };
  const prices = buildTable(site.tariff, 'price');
  const carbonIntensity = buildTable(site.carbon, 'intensity');

  // 预算
  const budgets = { cost: null, carbon: null };
  for (const key of ['cost', 'carbon']) {
    const b = site.budget[key];
    if (b) {
      checkNoUnit(b, `budget ${key}`);
      const v = evalConst(b.expr, `budget ${key}`);
      if (!(v >= 0)) throw new TypeCheckError(`budget ${key} 不能为负`, b.line, b.col);
      budgets[key] = v;
    }
  }

  // 维护窗
  const maintenance = [];
  for (const m of site.maintenance) {
    const s0 = timeToSlot(m.from);
    const s1 = timeToSlot(m.to);
    if (!(s0 < s1)) throw new TypeCheckError('维护窗起点必须早于终点', m.line, m.col);
    for (let s = s0; s < s1; s += 1) maintenance.push(s);
  }

  // 先后关系
  const orders = [];
  for (const o of site.orders) {
    if (!taskIds.has(o.a)) throw new TypeCheckError(`order 引用了未定义的任务 "${o.a}"`, o.line, o.col);
    if (!taskIds.has(o.b)) throw new TypeCheckError(`order 引用了未定义的任务 "${o.b}"`, o.line, o.col);
    if (o.a === o.b) throw new TypeCheckError(`任务 "${o.a}" 不能排在自身之前`, o.line, o.col);
    orders.push({ a: o.a, b: o.b, line: o.line, col: o.col });
  }

  // 目标表达式
  if (site.objective) checkObjectiveVars(site.objective.expr);

  return {
    name: site.name,
    capacity,
    prices,
    carbonIntensity,
    maintenance,
    maintenanceSet: new Set(maintenance),
    tasks,
    orders,
    objective: site.objective ? site.objective.expr : null,
    budgets,
  };
}
