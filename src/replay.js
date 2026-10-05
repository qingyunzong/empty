import { ReplayError, EXIT } from './errors.js';
import { topoSort, CausalGraph, validateEvents } from './eventlog.js';
import { BudgetBook, LAYERS, layerKey } from './budget.js';
import { LEGAL_TRANSITIONS, deriveStatus } from './machine.js';

export function replay(events) {
  events = validateEvents(events);
  const sorted = topoSort(events);
  const graph = new CausalGraph(events);
  const book = new BudgetBook();
  const tools = new Map();
  const usageEvents = new Map();
  const facts = [];
  const compensated = new Set();
  let overspend = null;

  const getTool = (id) => {
    if (!tools.has(id)) {
      tools.set(id, { id, status: 'idle', usage: 0, token: null, lockFact: null, scrap: [] });
      usageEvents.set(id, []);
    }
    return tools.get(id);
  };
  const limitsFor = (ev) => LAYERS.map((l) => book.limit(l, layerKey(l, ev)));

  for (const ev of sorted) {
    if (ev.type === 'budget') {
      const key = layerKey(ev.level, ev);
      book.setLimit(ev.level, key, ev.limit);
      facts.push({ kind: 'budget', event: ev.id, level: ev.level, key, limit: ev.limit });
      continue;
    }

    if (ev.type === 'cut' || ev.type === 'measure') {
      const tool = getTool(ev.tool);
      for (const pid of usageEvents.get(ev.tool)) {
        if (graph.concurrent(pid, ev.id)) {
          const prev = graph.byId.get(pid);
          throw new ReplayError(
            'CONFLICT',
            `concurrent ${prev.type} ${pid} and ${ev.type} ${ev.id} on tool ${ev.tool}: causally incomparable`,
            { tool: ev.tool, a: pid, b: ev.id },
          );
        }
      }
      usageEvents.get(ev.tool).push(ev.id);
      book.addUsage(ev, ev.length);
      tool.usage += ev.length;

      if (tool.lockFact) {
        if (ev.type === 'cut') {
          tool.scrap.push(ev.id);
          facts.push({ kind: 'scrap', tool: ev.tool, event: ev.id, reason: 'cut on locked tool' });
        }
        tool.token = ev.id;
        continue;
      }
      const exc = book.exceedances(ev);
      if (exc.length > 0) {
        tool.lockFact = { tool: ev.tool, event: ev.id, layers: exc };
        tool.status = 'locked';
        facts.push({ kind: 'locked', tool: ev.tool, event: ev.id, layers: exc });
        if (!overspend) overspend = { tool: ev.tool, event: ev.id, layers: exc };
      } else {
        tool.status = deriveStatus(tool.usage, limitsFor(ev));
      }
      tool.token = ev.id;
      continue;
    }

    if (ev.type === 'transition') {
      const tool = getTool(ev.tool);
      if (tool.token !== null && !graph.ancestors(ev.id).has(tool.token)) {
        throw new ReplayError(
          'ILLEGAL_TRANSITION',
          `causal guard failed: transition ${ev.id} does not causally follow ${tool.token}`,
          { tool: ev.tool, event: ev.id, token: tool.token },
        );
      }
      if (!LEGAL_TRANSITIONS[tool.status].includes(ev.to)) {
        throw new ReplayError(
          'ILLEGAL_TRANSITION',
          `illegal transition ${tool.status} -> ${ev.to} on tool ${ev.tool}`,
          { tool: ev.tool, event: ev.id, from: tool.status, to: ev.to },
        );
      }
      tool.status = ev.to;
      tool.token = ev.id;
      facts.push({ kind: 'transition', tool: ev.tool, event: ev.id, to: ev.to });
      continue;
    }

    if (ev.type === 'compensate') {
      const target = graph.byId.get(ev.target);
      if (!target || target.type !== 'measure') {
        throw new ReplayError('VALIDATION', `compensate ${ev.id}: target ${ev.target} is not a measure event`, { event: ev.id, target: ev.target });
      }
      if (compensated.has(ev.target)) {
        throw new ReplayError('VALIDATION', `compensate ${ev.id}: target ${ev.target} already compensated`, { event: ev.id, target: ev.target });
      }
      if (!graph.ancestors(ev.id).has(ev.target)) {
        throw new ReplayError('VALIDATION', `compensate ${ev.id} must causally follow its target ${ev.target}`, { event: ev.id, target: ev.target });
      }
      compensated.add(ev.target);
      const tool = getTool(ev.tool);
      book.addUsage(target, -target.length);
      tool.usage -= target.length;
      facts.push({ kind: 'compensate', tool: ev.tool, event: ev.id, target: ev.target, rolledBack: target.length });
      if (!tool.lockFact) {
        tool.status = deriveStatus(tool.usage, limitsFor(target));
        if (tool.status === 'locked') {
          const exc = book.exceedances(target);
          tool.lockFact = { tool: ev.tool, event: ev.id, layers: exc };
          facts.push({ kind: 'locked', tool: ev.tool, event: ev.id, layers: exc });
          if (!overspend) overspend = { tool: ev.tool, event: ev.id, layers: exc };
        }
      }
      tool.token = ev.id;
      continue;
    }
  }

  const toolsOut = {};
  for (const [id, t] of tools) {
    toolsOut[id] = { status: t.status, usage: t.usage, scrap: [...t.scrap], lockFact: t.lockFact };
  }
  return {
    events: events.length,
    tools: toolsOut,
    budgets: book.snapshot(),
    overspend,
    facts,
    exitCode: overspend ? EXIT.BUDGET_EXCEEDED : EXIT.OK,
  };
}

export function audit(events) {
  events = validateEvents(events);
  const graph = new CausalGraph(topoSort(events));
  const byTool = new Map();
  for (const e of events) {
    if (e.type !== 'cut' && e.type !== 'measure') continue;
    if (!byTool.has(e.tool)) byTool.set(e.tool, []);
    byTool.get(e.tool).push(e);
  }
  const conflicts = [];
  for (const [tool, list] of byTool) {
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        if (graph.concurrent(list[i].id, list[j].id)) {
          conflicts.push({ tool, a: list[i].id, b: list[j].id });
        }
      }
    }
  }

  let replayError = null;
  let result = null;
  try {
    result = replay(events);
  } catch (e) {
    if (e instanceof ReplayError) replayError = e;
    else throw e;
  }

  let exitCode = EXIT.OK;
  if (conflicts.length > 0 || (replayError && replayError.kind === 'CONFLICT')) exitCode = EXIT.CONFLICT;
  else if (replayError && replayError.kind === 'ILLEGAL_TRANSITION') exitCode = EXIT.ILLEGAL_TRANSITION;
  else if ((result && result.overspend) || (replayError && replayError.kind === 'BUDGET_EXCEEDED')) exitCode = EXIT.BUDGET_EXCEEDED;
  else if (replayError) exitCode = replayError.exitCode;

  const report = {
    ok: exitCode === EXIT.OK,
    events: events.length,
    conflicts,
    illegalTransition: replayError && replayError.kind === 'ILLEGAL_TRANSITION'
      ? { message: replayError.message, ...replayError.details }
      : null,
    overspend: result ? result.overspend : null,
    budgets: result ? result.budgets : null,
    tools: result ? result.tools : null,
  };
  return { report, exitCode };
}
