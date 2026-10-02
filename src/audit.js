import { refOf } from './model.js';
import { Interpreter } from './interpreter.js';

// Independent spec-level re-checks, deliberately separate from the
// interpreter internals so the audit is a genuine second computation.
export function specPermit(model, rules, reactor, recipe, version) {
  const workshop = model.reactorToWorkshop.get(reactor);
  const rank = { factory: 1, workshop: 2, reactor: 3 };
  const matches = rules.filter((r) => {
    if (!r.active || r.recipe !== recipe || r.version !== version) return false;
    if (r.level === 'factory') return true;
    if (r.level === 'workshop') return r.workshop === workshop;
    return r.reactor === reactor;
  });
  if (!matches.length) return false;
  matches.sort((a, b) => rank[b.level] - rank[a.level] || b.ts - a.ts);
  return matches[0].op === 'grant';
}

export function specForbidden(model, contents, recipe, version) {
  const ref = refOf(recipe, version);
  return contents.some((c) => (model.forbidden.get(c) ?? new Set()).has(ref));
}

// Replay the full event log for one reactor and prove that every allowed
// feed had a valid approval chain and triggered no forbidden combination.
export function auditReactor(model, events, reactor) {
  const full = new Interpreter(model).run(events);
  const replay = full.reactorLog.get(reactor) ?? [];
  const checks = [];
  let ok = true;
  const fresh = new Interpreter(model);
  for (const ev of events) {
    fresh.apply(ev);
    if (ev.op !== 'feed' || ev.reactor !== reactor) continue;
    const last = fresh.decisions[fresh.decisions.length - 1];
    if (last.decision !== 'allow') continue;
    const permitOk = specPermit(model, fresh.activeRules(), reactor, ev.recipe, ev.version);
    const contentsWithoutNew = [...(fresh.contents.get(reactor) ?? new Set())]
      .filter((c) => c !== refOf(ev.recipe, ev.version));
    const forbiddenOk = !specForbidden(model, contentsWithoutNew, ev.recipe, ev.version);
    const pass = permitOk && forbiddenOk;
    if (!pass) ok = false;
    checks.push({
      seq: last.seq,
      ts: ev.ts,
      recipe: ev.recipe,
      version: ev.version,
      approval: last.approval,
      permitOk,
      forbiddenOk,
      pass,
    });
  }
  return {
    reactor,
    workshop: model.reactorToWorkshop.get(reactor) ?? null,
    ok,
    checks,
    replay,
    deviations: full.deviations.filter((d) => d.feeds.some((f) => f.reactor === reactor)),
  };
}
