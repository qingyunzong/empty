import { DslError } from './errors.js';

export const MICRO = 1e6;
export const DENOM = 1000 * 60 * MICRO;

class Scope {
  constructor(parent = null) {
    this.parent = parent;
    this.templates = new Map();
  }

  define(template) {
    if (this.templates.has(template.name)) {
      throw new DslError(`duplicate template '${template.name}'`, template.loc);
    }
    this.templates.set(template.name, template);
  }

  lookup(name) {
    if (this.templates.has(name)) return this.templates.get(name);
    return this.parent ? this.parent.lookup(name) : null;
  }
}

function toNumber(q, what) {
  const v = Number(q.value);
  if (!Number.isFinite(v)) throw new DslError(`invalid ${what} '${q.value}'`, q.loc);
  return v;
}

function toInt(value, what, loc) {
  const v = Number(value);
  if (!Number.isInteger(v)) throw new DslError(`${what} must be an integer, got '${value}'`, loc);
  return v;
}

function checkObjective(expr) {
  switch (expr.kind) {
    case 'num':
      Number(expr.text);
      return;
    case 'var':
      return;
    case 'neg':
      checkObjective(expr.expr);
      return;
    case 'bin':
      checkObjective(expr.left);
      checkObjective(expr.right);
      if (expr.op === '/' && expr.right.kind === 'num' && Number(expr.right.text) === 0) {
        throw new DslError('division by zero in objective', expr.right.loc);
      }
      return;
    default:
      throw new DslError(`invalid objective expression node '${expr.kind}'`, expr.loc);
  }
}

export function objectiveToString(expr) {
  switch (expr.kind) {
    case 'num':
      return expr.text;
    case 'var':
      return expr.name;
    case 'neg':
      return `-${objectiveToString(expr.expr)}`;
    case 'bin':
      return `(${objectiveToString(expr.left)} ${expr.op} ${objectiveToString(expr.right)})`;
    default:
      return '?';
  }
}

function buildProfile(kind, spec, slots, slotMinutes) {
  const horizon = slots * slotMinutes;
  const micro = new Array(slots);
  const checkPrice = (q) => {
    if (q.unit && q.unit !== '元') {
      throw new DslError(`${kind} price expects unit '元' or none, got '${q.unit}'`, q.loc);
    }
    const v = toNumber(q, `${kind} price`);
    if (v < 0) throw new DslError(`${kind} price must be non-negative`, q.loc);
    return Math.round(v * MICRO);
  };
  const checkBound = (t) => {
    if (t.minutes > horizon) {
      throw new DslError(`time '${t.text}' is beyond the scheduling horizon`, t.loc);
    }
    if (t.minutes % slotMinutes !== 0) {
      throw new DslError(`time '${t.text}' is not aligned to ${slotMinutes}-minute slots`, t.loc);
    }
  };
  if (spec.kind === 'flat') {
    micro.fill(checkPrice(spec.value));
    return micro;
  }
  const blocks = spec.blocks.slice().sort((a, b) => a.start.minutes - b.start.minutes);
  let cursor = 0;
  for (const b of blocks) {
    checkBound(b.start);
    checkBound(b.end);
    if (b.start.minutes >= b.end.minutes) {
      throw new DslError(`${kind} block '${b.start.text} .. ${b.end.text}' is empty`, b.start.loc);
    }
    if (b.start.minutes !== cursor) {
      throw new DslError(
        `${kind} blocks must cover the whole horizon without gaps or overlaps (gap before '${b.start.text}')`,
        b.start.loc,
      );
    }
    cursor = b.end.minutes;
    const price = checkPrice(b.price);
    for (let s = b.start.minutes / slotMinutes; s < b.end.minutes / slotMinutes; s += 1) {
      micro[s] = price;
    }
  }
  if (cursor !== horizon) {
    const last = blocks.length ? blocks[blocks.length - 1].end : null;
    throw new DslError(`${kind} blocks do not cover the whole horizon`, last ? last.loc : {});
  }
  return micro;
}

function collectFields(templateFields, taskFields, taskLoc) {
  const merged = new Map();
  const apply = (fields, source) => {
    const seen = new Set();
    for (const f of fields) {
      if (seen.has(f.field)) {
        throw new DslError(`duplicate field '${f.field}' in ${source}`, f.loc);
      }
      seen.add(f.field);
      merged.set(f.field, f);
    }
  };
  if (templateFields) apply(templateFields, 'template');
  apply(taskFields, 'task');
  return merged;
}

function buildTask(taskAst, template, siteCtx) {
  const { slots, slotMinutes } = siteCtx;
  const fields = collectFields(template ? template.fields : null, taskAst.fields, taskAst.loc);

  const quantity = (name, unit, what) => {
    const f = fields.get(name);
    if (!f) return null;
    const q = f.value;
    if (q.unit !== unit) {
      throw new DslError(
        `type error: '${name}' expects ${what} (unit '${unit}') but got ${q.unit ? `unit '${q.unit}'` : 'a bare number'}`,
        q.loc,
      );
    }
    return toNumber(q, name);
  };

  const kw = quantity('power', 'kW', 'power');
  const durationMin = quantity('duration', 'min', 'duration');
  const kwh = quantity('energy', 'kWh', 'energy');

  if (kw == null) throw new DslError(`task '${taskAst.id}' has no 'power'`, taskAst.loc);
  if (kw <= 0) throw new DslError(`task '${taskAst.id}' power must be positive`, taskAst.loc);

  let minutes = durationMin;
  if (minutes == null && kwh != null) minutes = (kwh / kw) * 60;
  if (minutes == null) {
    throw new DslError(`task '${taskAst.id}' needs 'duration' or 'energy'`, taskAst.loc);
  }
  if (kwh != null && durationMin != null) {
    const expected = (kw * durationMin) / 60;
    if (Math.abs(expected - kwh) > 1e-9) {
      throw new DslError(
        `task '${taskAst.id}': energy ${kwh} kWh is inconsistent with power ${kw} kW x duration ${durationMin} min (= ${expected} kWh)`,
        fields.get('energy').value.loc,
      );
    }
  }
  if (!Number.isInteger(minutes) || minutes <= 0) {
    throw new DslError(`task '${taskAst.id}' duration must be a positive whole number of minutes`, taskAst.loc);
  }
  if (minutes % slotMinutes !== 0) {
    throw new DslError(
      `task '${taskAst.id}' duration ${minutes} min is not a multiple of the ${slotMinutes}-minute slot`,
      (fields.get('duration') ?? fields.get('energy')).loc,
    );
  }
  const durationSlots = minutes / slotMinutes;

  let winStart = 0;
  let winEnd = slots;
  const win = fields.get('window');
  if (win) {
    const { start, end } = win.value;
    const horizon = slots * slotMinutes;
    for (const t of [start, end]) {
      if (t.minutes > horizon) {
        throw new DslError(`window time '${t.text}' is beyond the scheduling horizon`, t.loc);
      }
      if (t.minutes % slotMinutes !== 0) {
        throw new DslError(`window time '${t.text}' is not aligned to ${slotMinutes}-minute slots`, t.loc);
      }
    }
    if (start.minutes >= end.minutes) {
      throw new DslError(`task '${taskAst.id}' window is empty`, win.loc);
    }
    winStart = start.minutes / slotMinutes;
    winEnd = end.minutes / slotMinutes;
  }

  const interruptible = fields.has('interruptible') ? fields.get('interruptible').value : false;
  let maxInterrupts = null;
  if (fields.has('maxInterrupts')) {
    const f = fields.get('maxInterrupts');
    maxInterrupts = toInt(f.value, 'maxInterrupts', f.loc);
    if (maxInterrupts < 0) throw new DslError('maxInterrupts must be >= 0', f.loc);
  }

  const after = [];
  const before = [];
  for (const f of [...(template ? template.fields : []), ...taskAst.fields]) {
    if (f.field === 'after') after.push(f.value);
    if (f.field === 'before') before.push(f.value);
  }

  return {
    id: taskAst.id,
    loc: taskAst.loc,
    watts: Math.round(kw * 1000),
    durationSlots,
    winStart,
    winEnd,
    interruptible,
    maxInterrupts,
    after,
    before,
    afterLocs: taskAst.fields.filter((f) => f.field === 'after' || f.field === 'before'),
  };
}

function checkSite(siteAst, globalScope) {
  const scope = new Scope(globalScope);
  for (const t of siteAst.templates) scope.define(t);

  const props = new Map();
  for (const p of siteAst.props) {
    if (props.has(p.key)) throw new DslError(`duplicate site property '${p.key}'`, p.loc);
    props.set(p.key, p);
  }

  const slots = props.has('slots') ? toInt(props.get('slots').value, 'slots', props.get('slots').loc) : 96;
  const slotMinutes = props.has('slotMinutes')
    ? toInt(props.get('slotMinutes').value, 'slotMinutes', props.get('slotMinutes').loc)
    : 15;
  if (slots <= 0) throw new DslError('slots must be positive', props.get('slots').loc);
  if (slotMinutes <= 0) throw new DslError('slotMinutes must be positive', props.get('slotMinutes').loc);
  const horizon = slots * slotMinutes;

  if (!props.has('tariff')) throw new DslError(`site '${siteAst.name}' has no 'tariff'`, siteAst.loc);
  const priceMicro = buildProfile('tariff', props.get('tariff').value, slots, slotMinutes);
  const carbonMicro = props.has('carbon')
    ? buildProfile('carbon', props.get('carbon').value, slots, slotMinutes)
    : new Array(slots).fill(0);

  const budget = (key) => {
    if (!props.has(key)) return null;
    const p = props.get(key);
    const v = toNumber({ value: p.value, loc: p.loc }, key);
    if (v < 0) throw new DslError(`${key} must be non-negative`, p.loc);
    return v;
  };
  const costBudget = budget('costBudget');
  const carbonBudget = budget('carbonBudget');

  let peakLimitW = null;
  if (props.has('peakLimit')) {
    const q = props.get('peakLimit').value;
    if (q.unit !== 'kW') {
      throw new DslError(`type error: 'peakLimit' expects power (unit 'kW')`, q.loc);
    }
    peakLimitW = Math.round(toNumber(q, 'peakLimit') * 1000);
  }

  const blocked = new Uint8Array(slots);
  const maintenanceRanges = [];
  for (const m of siteAst.maintenance) {
    for (const t of [m.start, m.end]) {
      if (t.minutes > horizon) {
        throw new DslError(`maintenance time '${t.text}' is beyond the scheduling horizon`, t.loc);
      }
      if (t.minutes % slotMinutes !== 0) {
        throw new DslError(`maintenance time '${t.text}' is not aligned to ${slotMinutes}-minute slots`, t.loc);
      }
    }
    if (m.start.minutes >= m.end.minutes) {
      throw new DslError('maintenance window is empty', m.loc);
    }
    const s = m.start.minutes / slotMinutes;
    const e = m.end.minutes / slotMinutes;
    maintenanceRanges.push([s, e]);
    for (let k = s; k < e; k += 1) blocked[k] = 1;
  }

  const taskIds = new Set();
  for (const t of siteAst.tasks) {
    if (taskIds.has(t.id)) throw new DslError(`duplicate task id '${t.id}'`, t.loc);
    taskIds.add(t.id);
  }

  const siteCtx = { slots, slotMinutes };
  const tasks = siteAst.tasks.map((t) => {
    let template = null;
    if (t.templateRef) {
      template = scope.lookup(t.templateRef);
      if (!template) throw new DslError(`unknown template '${t.templateRef}'`, t.templateLoc);
    }
    return buildTask(t, template, siteCtx);
  });

  for (const t of tasks) {
    for (const f of t.afterLocs) {
      if (f.value === t.id) throw new DslError(`task '${t.id}' cannot be '${f.field}' itself`, f.loc);
      if (!taskIds.has(f.value)) throw new DslError(`unknown task '${f.value}' in '${f.field}'`, f.loc);
    }
    delete t.afterLocs;
  }

  const objective = siteAst.objective
    ? siteAst.objective.expr
    : { kind: 'var', name: 'cost', loc: siteAst.loc };
  checkObjective(objective);

  return {
    name: siteAst.name,
    loc: siteAst.loc,
    slots,
    slotMinutes,
    priceMicro,
    carbonMicro,
    costBudget,
    carbonBudget,
    peakLimitW,
    blocked,
    maintenanceRanges,
    tasks,
    objective,
  };
}

export function check(program) {
  const globalScope = new Scope();
  for (const t of program.templates) globalScope.define(t);
  return { sites: program.sites.map((s) => checkSite(s, globalScope)) };
}
