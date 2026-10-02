import { canonicalEvent } from './events.js';

// Naive full-replay reference: folds the whole event stream into a store,
// then computes each device's alert timeline from scratch by direct
// evaluation of the expression tree at every candidate time. O(n^2)-ish,
// deliberately independent from the incremental VM, used to validate it.
//
// Truth definition at time t (fields are last-value-carried):
//   comparison      -> operands as of t; false if a field never reported
//   and/or/not      -> pointwise
//   sub for D       -> sub true at t-D AND at every event time in (t-D, t]

export function naiveReplay(program, events) {
  const store = new Map();
  let arrival = 0;
  for (const ev of events) {
    arrival += 1;
    const canonical = canonicalEvent(ev);
    const existing = store.get(ev.id);
    if (existing) {
      if (existing.canonical === canonical) continue;
      existing.live = false;
      store.set(ev.id, { kind: 'data', live: true, event: ev, arrival, canonical });
      continue;
    }
    if (ev.retracts !== undefined) {
      const target = store.get(ev.retracts);
      if (target) target.live = false;
      store.set(ev.id, { kind: 'retract', live: false, event: ev, arrival, canonical });
      continue;
    }
    if (ev.replaces !== undefined) {
      const target = store.get(ev.replaces);
      if (target) target.live = false;
    }
    store.set(ev.id, { kind: 'data', live: true, event: ev, arrival, canonical });
  }

  const byDevice = new Map();
  for (const s of store.values()) {
    if (s.kind !== 'data' || !s.live) continue;
    let list = byDevice.get(s.event.device);
    if (!list) byDevice.set(s.event.device, (list = []));
    list.push(s);
  }
  for (const list of byDevice.values()) {
    list.sort((a, b) => a.event.time - b.event.time || a.arrival - b.arrival);
  }

  const matches = (target, deviceId) =>
    target.kind === 'all' ||
    (target.kind === 'device' && target.id === deviceId) ||
    (target.kind === 'regex' && target.re.test(deviceId));

  const alerts = [];
  for (const [deviceId, list] of [...byDevice.entries()].sort()) {
    const devEvents = list.map((s) => s.event);
    const eventTimes = devEvents.map((e) => e.time);
    for (const rule of program.rules) {
      if (!matches(rule.target, deviceId)) continue;
      for (const iv of naiveIntervals(rule, devEvents, eventTimes)) {
        alerts.push({ rule: rule.name, device: deviceId, level: rule.level, start: iv.start, end: iv.end });
      }
    }
  }
  alerts.sort((a, b) => a.start - b.start || a.rule.localeCompare(b.rule) || a.device.localeCompare(b.device));
  return alerts;
}

function naiveIntervals(rule, devEvents, eventTimes) {
  const valueAt = (field, t) => {
    let v = null;
    for (const e of devEvents) {
      if (e.time > t) break;
      if (e.type === field) v = e.value;
    }
    return v;
  };

  const truth = (expr, t) => {
    switch (expr.kind) {
      case 'number': return expr.value;
      case 'ident': return valueAt(expr.name, t);
      case 'not': return !truth(expr.operand, t);
      case 'logic': {
        const l = truth(expr.left, t);
        return expr.op === 'and' ? l && truth(expr.right, t) : l || truth(expr.right, t);
      }
      case 'compare': {
        const a = truth(expr.left, t);
        const b = truth(expr.right, t);
        if (a === null || b === null) return false;
        switch (expr.op) {
          case '>': return a > b;
          case '>=': return a >= b;
          case '<': return a < b;
          case '<=': return a <= b;
          case '==': return a === b;
          case '!=': return a !== b;
          default: throw new Error(`bad op ${expr.op}`);
        }
      }
      case 'hold': {
        const d = expr.duration;
        if (d === 0) return truth(expr.operand, t);
        if (!truth(expr.operand, t - d)) return false;
        for (const s of eventTimes) {
          if (s <= t - d) continue;
          if (s > t) break;
          if (!truth(expr.operand, s)) return false;
        }
        return true;
      }
      default: throw new Error(`bad expr ${expr.kind}`);
    }
  };

  // Candidate change points: event times and event-time + duration expiries.
  const candidates = new Set(eventTimes);
  for (const e of devEvents) {
    for (const d of rule.holdDurations) candidates.add(e.time + d);
  }
  const sorted = [...candidates].sort((a, b) => a - b);

  const intervals = [];
  let open = null;
  let prev = false;
  for (const t of sorted) {
    const v = truth(rule.exprAst, t);
    if (v !== prev) {
      if (v) { open = { start: t, end: null }; intervals.push(open); }
      else open.end = t;
      prev = v;
    }
  }
  return intervals;
}
