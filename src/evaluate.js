import { PolicyError, prepare } from './policy.js';

export const BIG_DEPTH = 1 << 20;

export function isEmergency(rule) {
  return rule.emergency === true || rule.action === 'emergencyStop';
}

function parseHHMM(value) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

export function inWindow(window, time) {
  const t = Date.parse(time);
  if (window.start.includes('T') || window.end.includes('T')) {
    return t >= Date.parse(window.start) && t < Date.parse(window.end);
  }
  const start = parseHHMM(window.start);
  const end = parseHHMM(window.end);
  const d = new Date(t);
  const minutes = d.getUTCHours() * 60 + d.getUTCMinutes();
  if (start <= end) return minutes >= start && minutes < end;
  return minutes >= start || minutes < end;
}

function ensurePrepared(policies) {
  if (!policies._roleAncestors) prepare(policies);
  return policies;
}

function byDistanceThenId(a, b) {
  if (a.distance !== b.distance) return a.distance - b.distance;
  return a.rule.id < b.rule.id ? -1 : a.rule.id > b.rule.id ? 1 : 0;
}

function collectMatches(policies, req) {
  const subject = policies.subjects[req.subject];
  if (!subject) throw new PolicyError(`unknown subject: '${req.subject}'`, 3);
  const device = policies.devices[req.device];
  if (!device) throw new PolicyError(`unknown device: '${req.device}'`, 3);

  const roleChains = (subject.roles ?? []).map((r) => policies._roleAncestors.get(r));
  const zoneChain = policies._zoneAncestors.get(device.zone);

  const matches = [];
  for (const rule of policies.rules) {
    if (rule.action !== req.action && rule.action !== '*') continue;
    let roleDepth = BIG_DEPTH;
    if (rule.role !== undefined) {
      roleDepth = Infinity;
      for (const chain of roleChains) {
        const d = chain.get(rule.role);
        if (d !== undefined && d < roleDepth) roleDepth = d;
      }
      if (roleDepth === Infinity) continue;
    }
    let zoneDepth = BIG_DEPTH;
    if (rule.zone !== undefined) {
      const d = zoneChain.get(rule.zone);
      if (d === undefined) continue;
      zoneDepth = d;
    }
    if (rule.window && !inWindow(rule.window, req.time)) continue;
    const distance = (roleDepth + zoneDepth) * 2 + (rule.action === '*' ? 1 : 0);
    matches.push({ rule, roleDepth, zoneDepth, distance });
  }
  matches.sort(byDistanceThenId);
  return matches;
}

function decide(matches) {
  if (!matches.length) {
    return { decision: 'deny', reason: 'no-applicable-rule', winners: [], conflict: null };
  }
  const min = matches[0].distance;
  const level = matches.filter((m) => m.distance === min);
  const allows = level.filter((m) => m.rule.effect === 'allow');
  const denies = level.filter((m) => m.rule.effect === 'deny');
  if (allows.length && denies.length) {
    return {
      decision: 'deny',
      reason: 'conflict-deny',
      winners: denies,
      conflict: {
        distance: min,
        allow: allows.map((m) => m.rule.id),
        deny: denies.map((m) => m.rule.id),
        resolution: 'deny',
      },
    };
  }
  if (denies.length) {
    return { decision: 'deny', reason: 'rule-deny', winners: denies, conflict: null };
  }
  return { decision: 'allow', reason: 'rule-allow', winners: allows, conflict: null };
}

export function evaluate(policies, req, { counterexample = true } = {}) {
  ensurePrepared(policies);
  const matches = collectMatches(policies, req);
  const t = Date.parse(req.time);

  const live = [];
  const retro = [];
  for (const m of matches) {
    const rule = m.rule;
    if (rule.revokeAt) {
      if (isEmergency(rule)) {
        retro.push(m);
        continue;
      }
      if (t >= Date.parse(rule.revokeAt)) continue;
    }
    live.push(m);
  }

  const liveResult = decide(live);
  const fullResult = decide([...live, ...retro].sort(byDistanceThenId));

  let { decision, reason, winners, conflict } = liveResult;
  const retroactiveRevocations = [];
  if (decision === 'deny' && fullResult.decision === 'allow') {
    const retroWinners = fullResult.winners.filter((w) => retro.includes(w));
    if (retroWinners.length) {
      reason = 'retroactive-revocation';
      retroactiveRevocations.push(...retroWinners.map((w) => w.rule.id));
    }
  }

  const winnerSet = new Set(winners);
  const overridden = [];
  const minDist = winners.length ? winners[0].distance : null;
  for (const m of live) {
    if (winnerSet.has(m)) continue;
    let why = 'shadowed';
    if (minDist !== null && m.distance > minDist) why = 'less-specific';
    else if (conflict && conflict.allow.includes(m.rule.id)) why = 'conflict-deny-default';
    overridden.push({ rule: m.rule.id, effect: m.rule.effect, distance: m.distance, why });
  }
  for (const m of retro) {
    overridden.push({ rule: m.rule.id, effect: m.rule.effect, distance: m.distance, why: 'retroactive-revoked' });
  }

  const rulePath = [...live, ...retro].sort(byDistanceThenId).map((m) => ({
    rule: m.rule.id,
    effect: m.rule.effect,
    distance: m.distance,
    roleDepth: m.roleDepth,
    zoneDepth: m.zoneDepth,
    status: winnerSet.has(m) ? 'winner' : 'overridden',
  }));

  const record = {
    requestId: req.id ?? '(no-id)',
    subject: req.subject,
    device: req.device,
    action: req.action,
    time: req.time,
    decision,
    reason,
    winners: winners.map((w) => w.rule.id),
    rulePath,
    overridden,
    conflict,
    retroactiveRevocations,
  };
  if (counterexample) {
    record.counterexample = findCounterexample(policies, req, record);
  }
  return record;
}

function windowBoundaryTimes(window, time) {
  const out = [];
  if (window.start.includes('T') || window.end.includes('T')) {
    out.push(window.end);
    out.push(new Date(Date.parse(window.start) - 1000).toISOString());
  } else {
    const base = new Date(time);
    const end = new Date(base);
    const [eh, em] = window.end.split(':').map(Number);
    end.setUTCHours(eh, em, 0, 0);
    out.push(end.toISOString());
    const before = new Date(base);
    const [sh, sm] = window.start.split(':').map(Number);
    before.setUTCHours(sh, sm - 1, 0, 0);
    out.push(before.toISOString());
  }
  return out;
}

function tryRequestFlip(policies, req, change, decision) {
  const mutated = { ...req, ...change };
  const result = evaluate(policies, mutated, { counterexample: false });
  if (result.decision !== decision) {
    return { kind: 'request', change, resultingDecision: result.decision, verifies: true };
  }
  return null;
}

function tryPolicyFlip(policies, req, mutate, change, decision) {
  const clone = structuredClone(policies);
  mutate(clone);
  const result = evaluate(clone, req, { counterexample: false });
  if (result.decision !== decision) {
    return { kind: 'policy', change, resultingDecision: result.decision, verifies: true };
  }
  return null;
}

function removeRulesMutation(ids) {
  return (p) => {
    p.rules = p.rules.filter((r) => !ids.includes(r.id));
  };
}

export function findCounterexample(policies, req, record) {
  if (record.decision === 'allow') {
    const winnerRules = record.winners
      .map((id) => policies.rules.find((r) => r.id === id))
      .filter(Boolean);
    for (const rule of winnerRules) {
      const candidates = [];
      if (rule.window) candidates.push(...windowBoundaryTimes(rule.window, req.time));
      if (rule.revokeAt) candidates.push(rule.revokeAt);
      for (const time of candidates) {
        const hit = tryRequestFlip(policies, req, { time }, 'allow');
        if (hit) return hit;
      }
    }
    const allowIds = record.rulePath.filter((e) => e.effect === 'allow').map((e) => e.rule);
    const sets = [];
    if (record.winners.length) sets.push(record.winners);
    for (const id of allowIds) sets.push([id]);
    if (allowIds.length > 1) sets.push(allowIds);
    for (const set of sets) {
      const hit = tryPolicyFlip(policies, req, removeRulesMutation(set), { removeRules: set }, 'allow');
      if (hit) return hit;
    }
  } else {
    if (record.conflict) {
      const ids = record.conflict.deny;
      const hit = tryPolicyFlip(
        policies, req, removeRulesMutation(ids),
        { removeRules: ids, note: 'resolves allow/deny conflict at the decisive level' },
        'deny',
      );
      if (hit) return hit;
    }
    const denyIds = record.rulePath.filter((e) => e.effect === 'deny').map((e) => e.rule);
    const sets = [];
    if (record.winners.length) sets.push(record.winners);
    for (const id of denyIds) sets.push([id]);
    if (denyIds.length > 1) sets.push(denyIds);
    for (const set of sets) {
      const hit = tryPolicyFlip(policies, req, removeRulesMutation(set), { removeRules: set }, 'deny');
      if (hit) return hit;
    }
    const subject = policies.subjects[req.subject];
    const device = policies.devices[req.device];
    const newRule = { id: '__cex_allow__', effect: 'allow', action: req.action };
    if (subject?.roles?.length) newRule.role = subject.roles[0];
    if (device?.zone) newRule.zone = device.zone;
    const hit = tryPolicyFlip(
      policies, req,
      (p) => { p.rules = [...p.rules, newRule]; },
      { addRule: newRule },
      'deny',
    );
    if (hit) return hit;
  }
  return { kind: 'none', verifies: false, note: 'no single-change counterexample found' };
}

export function applyCounterexample(policies, req, cex) {
  if (cex.kind === 'request') {
    return { policies, req: { ...req, ...cex.change } };
  }
  if (cex.kind === 'policy') {
    const clone = structuredClone(policies);
    if (cex.change.removeRules) {
      clone.rules = clone.rules.filter((r) => !cex.change.removeRules.includes(r.id));
    }
    if (cex.change.addRule) {
      clone.rules = [...clone.rules, cex.change.addRule];
    }
    return { policies: clone, req };
  }
  return null;
}

export function verifyRecord(policies, req, record) {
  const problems = [];
  const fresh = evaluate(policies, req, { counterexample: false });
  if (fresh.decision !== record.decision) {
    problems.push(`decision mismatch: record=${record.decision} actual=${fresh.decision}`);
  }
  if (JSON.stringify(fresh.winners) !== JSON.stringify(record.winners)) {
    problems.push(`winners mismatch: record=[${record.winners}] actual=[${fresh.winners}]`);
  }
  const cex = record.counterexample;
  if (!cex || cex.verifies !== true) {
    problems.push('counterexample missing or not verified');
  } else {
    const applied = applyCounterexample(policies, req, cex);
    if (!applied) {
      problems.push(`counterexample kind '${cex.kind}' cannot be applied`);
    } else {
      const flipped = evaluate(applied.policies, applied.req, { counterexample: false });
      if (flipped.decision !== cex.resultingDecision || flipped.decision === record.decision) {
        problems.push('counterexample does not reproduce the flipped decision');
      }
    }
  }
  return { ok: problems.length === 0, problems };
}
