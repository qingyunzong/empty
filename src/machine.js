import { isConcurrent, happensBefore } from './vc.js';
import { keyOf, cmpEvent } from './events.js';

// Work-order state machine. create may only apply when the WO does not exist.
export const WO_TRANSITIONS = Object.freeze({
  create: Object.freeze({ from: Object.freeze([null]), to: 'new' }),
  assign: Object.freeze({ from: Object.freeze(['new', 'assigned']), to: 'assigned' }),
  start: Object.freeze({ from: Object.freeze(['assigned']), to: 'in_progress' }),
  complete: Object.freeze({ from: Object.freeze(['in_progress']), to: 'completed' }),
  cancel: Object.freeze({ from: Object.freeze(['new', 'assigned', 'in_progress']), to: 'cancelled' }),
});

export const WO_OPS = Object.freeze(Object.keys(WO_TRANSITIONS));
export const ALARM_OPS = Object.freeze(['raise', 'clear']);

export function emptyState() {
  return { vc: {}, applied: {}, workorders: {}, alarms: {}, pending: [], conflicts: [] };
}

export function refOf(e) {
  return {
    id: e.id, site: e.site, seq: e.seq, vc: e.vc, kind: e.kind, op: e.op,
    wo: e.wo, alarm: e.alarm, actor: e.actor, team: e.team, interlock: e.interlock,
  };
}

// An event is causally ready when every site entry in its vector clock is
// satisfied by the applied frontier (its own site must be exactly one behind).
export function depsSatisfied(e, vc) {
  for (const [site, n] of Object.entries(e.vc)) {
    if (site === e.site) {
      if ((vc[site] || 0) !== n - 1) return false;
    } else if ((vc[site] || 0) < n) {
      return false;
    }
  }
  return true;
}

function stepWorkorder(state, e) {
  const wo = state.workorders[e.wo] || null;
  const t = WO_TRANSITIONS[e.op];
  if (!t) return { decision: 'rejected', reason: 'unknown-op' };
  if (e.op === 'create') {
    if (wo) return { decision: 'rejected', reason: 'wo-exists' };
    state.workorders[e.wo] = { id: e.wo, status: 'new', team: null, createdBy: e.actor, lastAssign: null };
    return { decision: 'applied', reason: 'ok' };
  }
  if (!wo) return { decision: 'rejected', reason: 'no-such-wo' };
  if (!t.from.includes(wo.status)) {
    return { decision: 'rejected', reason: 'illegal-transition', detail: `${wo.status}->${e.op}` };
  }
  if (e.op === 'assign') {
    const last = wo.lastAssign;
    if (wo.status === 'assigned' && last && last.team !== e.team && isConcurrent(last.vc, e.vc)) {
      const conflict = { type: 'concurrent-assign', wo: e.wo, first: last.id, second: e.id, teams: [last.team, e.team] };
      if (last.interlock || e.interlock) {
        // Safety-interlock conflicts are never auto-resolved: hold for review.
        state.conflicts.push({ ...conflict, resolution: 'pending', reason: 'safety-interlock' });
        state.pending.push(e);
        return { decision: 'pending', reason: 'interlock-conflict' };
      }
      // Deterministic rule: the assign first in the (site, seq) order wins;
      // the fold applies events in that order, so the current holder wins.
      state.conflicts.push({ ...conflict, resolution: 'first-wins', winner: last.id, loser: e.id });
      return { decision: 'rejected', reason: 'conflict-loser' };
    }
    wo.team = e.team;
    wo.lastAssign = refOf(e);
  }
  wo.status = t.to;
  return { decision: 'applied', reason: 'ok' };
}

function stepAlarm(state, e, ctx) {
  const al = state.alarms[e.alarm] || null;
  if (e.op === 'raise') {
    if (al && al.status === 'raised') return { decision: 'rejected', reason: 'already-raised' };
    state.alarms[e.alarm] = { id: e.alarm, wo: e.wo, status: 'raised', raise: refOf(e), clear: null };
    return { decision: 'applied', reason: 'ok' };
  }
  if (e.op === 'clear') {
    if (!al) {
      // Unknown causality: the raise is missing (or not yet applied). Defer;
      // the fold will either apply the raise first or park this in pending.
      return { decision: 'defer' };
    }
    if (al.status !== 'raised') return { decision: 'rejected', reason: 'not-raised' };
    // clear is only valid when it is causally later than the raise.
    if (!happensBefore(al.raise.vc, e.vc)) {
      return { decision: 'rejected', reason: 'clear-not-after-raise' };
    }
    al.status = 'cleared';
    al.clear = refOf(e);
    return { decision: 'applied', reason: 'ok' };
  }
  return { decision: 'rejected', reason: 'unknown-op' };
}

export function step(state, e, ctx = {}) {
  if (e.kind === 'alarm') return stepAlarm(state, e, ctx);
  return stepWorkorder(state, e);
}

// Deterministically fold a set of events into state. Delivery order does not
// matter: duplicates are dropped by site:seq, events are applied in causal
// order with a deterministic (site, seq) tie-break, and anything whose
// causality cannot be resolved ends up in state.pending.
export function foldAll(events) {
  const seen = new Set();
  const uniq = [];
  const duplicates = [];
  for (const e of events) {
    const k = keyOf(e);
    if (seen.has(k)) {
      duplicates.push(e);
      continue;
    }
    seen.add(k);
    uniq.push(e);
  }
  const state = emptyState();
  const decisions = [];
  let remaining = uniq.slice();
  for (;;) {
    const ready = remaining.filter((e) => depsSatisfied(e, state.vc)).sort(cmpEvent);
    let progressed = false;
    for (const e of ready) {
      const r = step(state, e, { remaining });
      if (r.decision === 'defer') continue;
      remaining.splice(remaining.indexOf(e), 1);
      // Rejected and held events still advance the frontier so later events
      // from the same site are not blocked; each event is processed once.
      state.vc[e.site] = (state.vc[e.site] || 0) + 1;
      state.applied[keyOf(e)] = { id: e.id, decision: r.decision };
      decisions.push({ event: refOf(e), ...r });
      progressed = true;
      break;
    }
    if (!progressed) break;
  }
  remaining.sort(cmpEvent);
  for (const e of remaining) {
    const reason = e.kind === 'alarm' && e.op === 'clear' && !state.alarms[e.alarm]
      ? 'raise-unknown'
      : 'causal-deps-missing';
    state.pending.push(e);
    decisions.push({ event: refOf(e), decision: 'pending', reason });
  }
  return { state, decisions, duplicates };
}

// Local pre-check used by `emit` before an event is created.
export function validateLocal(state, { kind, op, wo, alarm }) {
  if (kind === 'alarm') {
    const al = state.alarms[alarm] || null;
    if (op === 'raise') {
      if (al && al.status === 'raised') return { ok: false, reason: 'already-raised' };
      return { ok: true };
    }
    if (!al) return { ok: false, reason: 'raise-unknown' };
    if (al.status !== 'raised') return { ok: false, reason: 'not-raised' };
    return { ok: true };
  }
  if (op === 'create') {
    return state.workorders[wo] ? { ok: false, reason: 'wo-exists' } : { ok: true };
  }
  const w = state.workorders[wo];
  if (!w) return { ok: false, reason: 'no-such-wo' };
  const t = WO_TRANSITIONS[op];
  if (!t.from.includes(w.status)) {
    return { ok: false, reason: 'illegal-transition', detail: `${w.status}->${op}` };
  }
  return { ok: true };
}
