import { EXIT } from './errors.js';
import { stableStringify } from './model.js';

export function normalizeConfig(raw = {}) {
  const toNum = (v) => {
    if (v == null) return Infinity;
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return v;
    if (typeof v === 'object') return toNum(v.budget ?? v.life);
    return Infinity;
  };
  const toMap = (obj) => new Map(Object.entries(obj ?? {}).map(([k, v]) => [k, toNum(v)]));
  return {
    toolLife: toMap(raw.tools),
    orderBudget: toMap(raw.orders),
    opBudget: toMap(raw.operations),
    segBudget: toMap(raw.segments),
  };
}

export function layerKeysOf(ev) {
  return [
    ['seg', `${ev.order}/${ev.op}/${ev.seg}`],
    ['op', `${ev.order}/${ev.op}`],
    ['order', ev.order],
  ];
}

export function simulate(ordered, ctx, config) {
  const { byId, pastOf } = ctx;
  const tools = new Map();
  const layers = new Map();
  const scraps = [];
  const locks = [];
  const compensations = [];
  const recovery = [];
  const errors = [];
  const lockedFacts = new Set();
  const compensated = new Set();

  const budgetFor = (kind, key) => {
    if (kind === 'seg') return config.segBudget.get(key) ?? Infinity;
    if (kind === 'op') return config.opBudget.get(key) ?? Infinity;
    return config.orderBudget.get(key) ?? Infinity;
  };
  const getTool = (id) => {
    if (!tools.has(id)) tools.set(id, { state: 'idle', used: 0, life: config.toolLife.get(id) ?? Infinity });
    return tools.get(id);
  };
  const bumpLayer = (kind, key, delta) => {
    if (!layers.has(key)) layers.set(key, { kind, used: 0, budget: budgetFor(kind, key) });
    const layer = layers.get(key);
    layer.used += delta;
    return layer;
  };
  const consume = (ev, sign) => {
    const tool = getTool(ev.tool);
    tool.used += sign * ev.length;
    for (const [kind, key] of layerKeysOf(ev)) bumpLayer(kind, key, sign * ev.length);
    return tool;
  };
  const pushError = (code, message, details) => {
    errors.push({ code, message, details });
  };
  const lockTool = (tool, ev, exceeded) => {
    tool.state = 'locked';
    for (const id of pastOf.get(ev.id)) lockedFacts.add(id);
    for (const [kind, key, used, budget] of exceeded) {
      locks.push({ event: ev.id, tool: ev.tool, kind, key, used, budget });
    }
    const [kind, key, used, budget] = exceeded[0];
    pushError(
      EXIT.BUDGET,
      `budget exceeded at ${ev.id}: ${kind} ${key} used ${used} > budget ${budget}`,
      { event: ev.id, kind, key, used, budget },
    );
  };

  for (const ev of ordered) {
    if (ev.type === 'measure' || ev.type === 'cut') {
      const tool = getTool(ev.tool);
      if (tool.state === 'locked') {
        pushError(EXIT.TRANSITION, `illegal transition: ${ev.type} ${ev.id} on locked tool ${ev.tool}`, {
          event: ev.id, tool: ev.tool, from: 'locked', to: 'cutting',
        });
        continue;
      }
      if (tool.state === 'worn') {
        const t = consume(ev, +1);
        if (ev.type === 'cut') scraps.push({ event: ev.id, tool: ev.tool, order: ev.order, op: ev.op, seg: ev.seg });
        lockTool(tool, ev, [['tool', ev.tool, t.used, t.life]]);
        continue;
      }
      tool.state = 'cutting';
      const t = consume(ev, +1);
      const exceeded = [];
      if (t.used > t.life) exceeded.push(['tool', ev.tool, t.used, t.life]);
      for (const [kind, key] of layerKeysOf(ev)) {
        const layer = layers.get(key);
        if (layer.used > layer.budget) exceeded.push([kind, key, layer.used, layer.budget]);
      }
      if (exceeded.length > 0) {
        if (ev.type === 'cut' && t.used > t.life) {
          scraps.push({ event: ev.id, tool: ev.tool, order: ev.order, op: ev.op, seg: ev.seg });
        }
        lockTool(tool, ev, exceeded);
      } else if (t.used === t.life) {
        tool.state = 'worn';
      }
    } else if (ev.type === 'tool_change') {
      const tool = getTool(ev.tool);
      if (tool.state === 'locked') {
        pushError(EXIT.TRANSITION, `illegal transition: tool_change ${ev.id} on locked tool ${ev.tool}`, {
          event: ev.id, tool: ev.tool, from: 'locked', to: 'idle',
        });
        continue;
      }
      tool.state = 'idle';
      tool.used = 0;
    } else if (ev.type === 'compensate') {
      const target = byId.get(ev.target);
      if (!target || target.type !== 'measure') {
        pushError(EXIT.TRANSITION, `illegal compensation ${ev.id}: target ${ev.target} is not a measurement`, {
          event: ev.id, target: ev.target,
        });
        continue;
      }
      if (!pastOf.get(ev.id).has(ev.target)) {
        pushError(EXIT.TRANSITION, `illegal compensation ${ev.id}: must causally depend on target ${ev.target}`, {
          event: ev.id, target: ev.target,
        });
        continue;
      }
      if (compensated.has(ev.target)) {
        pushError(EXIT.TRANSITION, `illegal compensation ${ev.id}: target ${ev.target} already compensated`, {
          event: ev.id, target: ev.target,
        });
        continue;
      }
      compensated.add(ev.target);
      if (lockedFacts.has(ev.target)) {
        recovery.push({
          compensation: ev.id,
          target: ev.target,
          reason: 'target is a locked fact; locked facts cannot be rewritten, only a recovery path is generated',
          preservedFacts: {
            locks: locks.filter((l) => pastOf.get(l.event).has(ev.target)),
            scraps: scraps.filter((s) => pastOf.get(s.event).has(ev.target)),
          },
          suggestions: [
            {
              type: 'tool_change',
              tool: `${target.tool}-R${recovery.length + 1}`,
              reason: `tool ${target.tool} is locked; continue with a fresh tool`,
            },
            {
              type: 'measure',
              tool: `${target.tool}-R${recovery.length + 1}`,
              order: target.order,
              op: target.op,
              seg: target.seg,
              reason: 're-measure the segment with a calibrated device',
            },
          ],
        });
        continue;
      }
      const tool = consume(target, -1);
      compensations.push({ id: ev.id, target: ev.target, length: target.length });
      if (tool.state !== 'locked') {
        tool.state = tool.used === 0 ? 'idle' : tool.used === tool.life ? 'worn' : 'cutting';
      }
    }
  }

  const firstError = errors.length > 0 ? errors[0] : null;
  const nullable = (n) => (n === Infinity ? null : n);
  const byKeyAsc = ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0);
  return {
    tools: Object.fromEntries(
      [...tools.entries()].sort(byKeyAsc).map(([id, t]) => [id, { state: t.state, used: t.used, life: nullable(t.life) }]),
    ),
    layers: [...layers.entries()].sort(byKeyAsc).map(([key, l]) => ({
      key,
      kind: l.kind,
      used: l.used,
      budget: nullable(l.budget),
      remaining: l.budget === Infinity ? null : l.budget - l.used,
    })),
    scraps,
    locks,
    compensations,
    recovery,
    errors,
    firstError,
    overspendPoint: locks.length > 0 ? locks[0].event : null,
  };
}

export function signature(outcome) {
  return stableStringify({
    tools: outcome.tools,
    layers: outcome.layers,
    scraps: outcome.scraps,
    locks: outcome.locks,
    compensations: outcome.compensations,
    recovery: outcome.recovery,
    errors: outcome.errors,
  });
}
