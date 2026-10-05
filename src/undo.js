import { ReplayError } from './errors.js';
import { replay } from './replay.js';
import { topoSort } from './eventlog.js';
import { LAYERS, layerKey } from './budget.js';

export function planUndo(events, targetId) {
  const target = events.find((e) => e.id === targetId);
  if (!target) throw new ReplayError('VALIDATION', `no such event ${targetId}`, { target: targetId });
  if (target.type !== 'measure') {
    throw new ReplayError('VALIDATION', `undo target ${targetId} is a ${target.type}; only measure events can be undone`, { target: targetId });
  }
  if (events.some((e) => e.type === 'compensate' && e.target === targetId)) {
    throw new ReplayError('VALIDATION', `measure ${targetId} is already compensated`, { target: targetId });
  }

  const before = replay(events);

  // The compensation event must causally follow both its target and the tool's
  // latest state token, so replay can place it unambiguously.
  const token = lastToken(events, target.tool);
  const comp = {
    type: 'compensate',
    id: `cmp:${targetId}`,
    tool: target.tool,
    target: targetId,
    causes: [...new Set([targetId, token].filter(Boolean))],
  };

  const after = replay([...events, comp]);

  const rollback = LAYERS.map((layer) => {
    const key = layerKey(layer, target);
    const b = (before.budgets[layer] && before.budgets[layer][key]) || { usage: 0, limit: null };
    const a = (after.budgets[layer] && after.budgets[layer][key]) || { usage: 0, limit: null };
    return { layer, key, before: b.usage, after: a.usage, limit: a.limit };
  });

  const recoveryPath = [{ step: 'append_compensation', event: comp }];
  for (const r of rollback) recoveryPath.push({ step: 'rollback', ...r });

  const toolBefore = before.tools[target.tool];
  const lockedFact = toolBefore ? toolBefore.lockFact : null;
  if (lockedFact) {
    recoveryPath.push({ step: 'locked_fact_retained', fact: lockedFact, note: 'locked facts are immutable; compensation cannot rewrite them' });
    recoveryPath.push({ step: 'replace_tool', tool: target.tool });
    recoveryPath.push({ step: 'requalify_tool', tool: target.tool });
  } else {
    recoveryPath.push({ step: 'resume', tool: target.tool, status: after.tools[target.tool].status });
  }

  const scrap = toolBefore ? toolBefore.scrap : [];
  if (scrap.length > 0) {
    recoveryPath.push({
      step: 'scrap_verdict',
      tool: target.tool,
      cuts: scrap,
      reversible: false,
      note: 'scrap produced while locked stays marked; no recovery can unmark it',
    });
  }

  return {
    target: targetId,
    compensation: comp,
    rollback,
    lockedFacts: lockedFact ? [lockedFact] : [],
    scrap,
    recoveryPath,
    status: after.tools[target.tool] ? after.tools[target.tool].status : 'idle',
  };
}

function lastToken(events, tool) {
  let token = null;
  for (const e of topoSort(events)) {
    if (e.tool === tool && ['cut', 'measure', 'transition', 'compensate'].includes(e.type)) {
      token = e.id;
    }
  }
  return token;
}
