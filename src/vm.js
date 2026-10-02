import { DiagnosticError } from './errors.js';
import { canonicalEvent } from './events.js';

// Incremental VM. Maintains, per device, the live event window (sorted store)
// and the current alert state per rule. In-order events extend the evaluation
// incrementally; out-of-order events, corrections and retractions recompute
// the affected device's timeline and reconcile it against the alerts already
// emitted, so the final effective alert set always equals a full replay.
//
// Semantics:
//   - Field values are last-value-carried between readings.
//   - A comparison over a field that never reported is false.
//   - `cond for D` is true once `cond` held continuously for D ms; pending
//     durations fire at their exact expiry, even past the last event.
//   - At equal timestamps events are applied before duration expiries.

const CMP = {
  GT: (a, b) => a > b, GE: (a, b) => a >= b, LT: (a, b) => a < b,
  LE: (a, b) => a <= b, EQ: (a, b) => a === b, NE: (a, b) => a !== b,
};

const iso = (t) => new Date(t).toISOString();

export class VM {
  constructor(program) {
    this.rules = program.rules;
    this.store = new Map();   // event id -> { kind, live, event, canonical, arrival }
    this.devices = new Map(); // device id -> DeviceState
    this.records = [];
    this.alertSeq = 0;
    this.recordSeq = 0;
    this.arrivalSeq = 0;
  }

  // ---- public API ----

  ingest(ev, eventLine) {
    const fail = (msg) => { throw new DiagnosticError(msg, { phase: 'event', event: eventLine }); };
    const canonical = canonicalEvent(ev);

    const existing = this.store.get(ev.id);
    if (existing) {
      if (existing.canonical === canonical) return; // exact duplicate: idempotent no-op
      // Same id, different payload: a re-sent data event acts as a correction
      // of the earlier one; any other id conflict is a domain error.
      if (existing.kind === 'data' && !ev.retracts) {
        existing.live = false;
        this.store.set(ev.id, { kind: 'data', live: true, event: ev, canonical, arrival: ++this.arrivalSeq });
        const affected = new Set([ev.device, existing.event.device]);
        for (const deviceId of affected) this.applyChange(deviceId, ev.time, null);
        return;
      }
      fail(`conflicting event id "${ev.id}"`);
    }

    if (ev.retracts !== undefined) {
      const target = this.store.get(ev.retracts);
      if (!target || target.kind !== 'data' || !target.live) {
        fail(`unknown event id "${ev.retracts}" in "retracts"`);
      }
      target.live = false;
      this.store.set(ev.id, { kind: 'retract', live: true, event: ev, canonical, arrival: ++this.arrivalSeq });
      this.applyChange(target.event.device, target.event.time, null);
      return;
    }

    if (ev.replaces !== undefined) {
      const target = this.store.get(ev.replaces);
      if (!target || target.kind !== 'data' || !target.live) {
        fail(`unknown event id "${ev.replaces}" in "replaces"`);
      }
      target.live = false;
      this.store.set(ev.id, { kind: 'data', live: true, event: ev, canonical, arrival: ++this.arrivalSeq });
      const affected = new Set([ev.device, target.event.device]);
      for (const deviceId of affected) this.applyChange(deviceId, ev.time, null);
      return;
    }

    this.store.set(ev.id, { kind: 'data', live: true, event: ev, canonical, arrival: ++this.arrivalSeq });
    this.applyChange(ev.device, ev.time, ev);
  }

  // Fires all pending duration expiries (end-of-input flush).
  flush() {
    for (const deviceId of [...this.devices.keys()].sort()) {
      const dev = this.devices.get(deviceId);
      for (const [ruleIdx, rs] of dev.rules) {
        this.settleAll(rs, this.rules[ruleIdx], this.liveSink(dev, ruleIdx, rs));
      }
    }
  }

  // Effective (currently valid) alerts: the reconciled final state.
  effectiveAlerts() {
    const out = [];
    for (const [deviceId, dev] of [...this.devices.entries()].sort()) {
      for (const [ruleIdx, entries] of [...dev.emitted.entries()].sort()) {
        const rule = this.rules[ruleIdx];
        for (const e of entries) {
          if (!e.alive) continue;
          out.push({ rule: rule.name, device: deviceId, level: rule.level, start: e.start, end: e.end });
        }
      }
    }
    out.sort((a, b) => a.start - b.start || a.rule.localeCompare(b.rule) || a.device.localeCompare(b.device));
    return out;
  }

  // ---- device state ----

  getDevice(deviceId) {
    let dev = this.devices.get(deviceId);
    if (!dev) {
      dev = { id: deviceId, events: [], lastTime: -Infinity, rules: new Map(), emitted: new Map() };
      this.devices.set(deviceId, dev);
    }
    return dev;
  }

  matchingRules(deviceId) {
    const out = [];
    for (let i = 0; i < this.rules.length; i++) {
      const t = this.rules[i].target;
      if (t.kind === 'all' ||
          (t.kind === 'device' && t.id === deviceId) ||
          (t.kind === 'regex' && t.re.test(deviceId))) out.push(i);
    }
    return out;
  }

  freshRuleState(rule) {
    return {
      fields: new Map(),
      holds: Array.from({ length: rule.holdCount }, () => ({ since: null })),
      value: false,
      lastTime: -Infinity,
      openAlert: null,
    };
  }

  liveRuleState(dev, ruleIdx) {
    let rs = dev.rules.get(ruleIdx);
    if (!rs) {
      rs = this.freshRuleState(this.rules[ruleIdx]);
      dev.rules.set(ruleIdx, rs);
    }
    return rs;
  }

  // ---- record emission ----

  emit(rec) {
    rec.seq = ++this.recordSeq;
    this.records.push(rec);
  }

  emitAlert(rule, deviceId, start) {
    const id = `a${++this.alertSeq}`;
    this.emit({ kind: 'alert', alert: id, rule: rule.name, device: deviceId, level: rule.level, time: iso(start) });
    return id;
  }

  emitWithdraw(rule, deviceId, alertId, time, reason) {
    this.emit({
      kind: 'withdraw', alert: alertId, rule: rule.name, device: deviceId,
      time: time === null ? null : iso(time), reason,
    });
  }

  liveSink(dev, ruleIdx, rs) {
    const rule = this.rules[ruleIdx];
    return {
      open: (t) => {
        const id = this.emitAlert(rule, dev.id, t);
        rs.openAlert = { id, start: t };
        let entries = dev.emitted.get(ruleIdx);
        if (!entries) dev.emitted.set(ruleIdx, (entries = []));
        const entry = { id, start: t, end: null, alive: true };
        entries.push(entry);
        rs.openAlert.entry = entry;
      },
      close: (t) => {
        this.emitWithdraw(rule, dev.id, rs.openAlert.id, t, 'recovered');
        rs.openAlert.entry.end = t;
        rs.openAlert = null;
      },
    };
  }

  // ---- evaluation ----

  evalAt(rs, rule, t, sink) {
    const stack = [];
    for (const ins of rule.code) {
      switch (ins.op) {
        case 'PUSH': stack.push(ins.value); break;
        case 'LOAD': stack.push(rs.fields.has(ins.field) ? rs.fields.get(ins.field) : null); break;
        case 'AND': { const b = stack.pop(), a = stack.pop(); stack.push(a && b); break; }
        case 'OR': { const b = stack.pop(), a = stack.pop(); stack.push(a || b); break; }
        case 'NOT': stack.push(!stack.pop()); break;
        case 'HOLD': {
          const b = stack.pop();
          const st = rs.holds[ins.slot];
          if (!b) { st.since = null; stack.push(false); }
          else {
            if (st.since === null) st.since = t;
            stack.push(t - st.since >= ins.duration);
          }
          break;
        }
        default: { // comparisons
          const b = stack.pop(), a = stack.pop();
          stack.push(a === null || b === null ? false : CMP[ins.op](a, b));
        }
      }
    }
    const value = stack.pop();
    rs.lastTime = t;
    if (value !== rs.value) {
      rs.value = value;
      if (value) sink.open(t); else sink.close(t);
    }
  }

  nextExpiry(rs, rule) {
    let next = null;
    for (let i = 0; i < rule.holdCount; i++) {
      const since = rs.holds[i].since;
      if (since === null) continue;
      const expiry = since + rule.holdDurations[i];
      if (expiry > rs.lastTime && (next === null || expiry < next)) next = expiry;
    }
    return next;
  }

  // Fires pending expiries strictly before t (events win ties at equal times).
  settleBefore(rs, rule, t, sink) {
    for (;;) {
      const next = this.nextExpiry(rs, rule);
      if (next === null || next >= t) return;
      this.evalAt(rs, rule, next, sink);
    }
  }

  settleAll(rs, rule, sink) {
    for (;;) {
      const next = this.nextExpiry(rs, rule);
      if (next === null) return;
      this.evalAt(rs, rule, next, sink);
    }
  }

  // One event applied to one rule state: due expiries first, then the event.
  stepEvent(rs, rule, ev, sink) {
    this.settleBefore(rs, rule, ev.time, sink);
    rs.fields.set(ev.type, ev.value);
    this.evalAt(rs, rule, ev.time, sink);
  }

  // ---- change application ----

  applyChange(deviceId, changeTime, appendEvent) {
    const dev = this.getDevice(deviceId);
    const isAppend = appendEvent !== null &&
      (dev.events.length === 0 || appendEvent.time > dev.lastTime);

    if (isAppend) {
      // Fast path: extend the live evaluation with the new event.
      dev.events.push({ event: appendEvent, arrival: this.arrivalSeq });
      dev.lastTime = appendEvent.time;
      for (const ruleIdx of this.matchingRules(deviceId)) {
        const rs = this.liveRuleState(dev, ruleIdx);
        this.stepEvent(rs, this.rules[ruleIdx], appendEvent, this.liveSink(dev, ruleIdx, rs));
      }
      return;
    }
    this.recomputeDevice(dev, changeTime);
  }

  recomputeDevice(dev, changeTime) {
    // Rebuild the sorted live event window.
    dev.events = [...this.store.values()]
      .filter((s) => s.kind === 'data' && s.live && s.event.device === dev.id)
      .map((s) => ({ event: s.event, arrival: s.arrival }))
      .sort((a, b) => a.event.time - b.event.time || a.arrival - b.arrival);
    dev.lastTime = dev.events.length ? dev.events[dev.events.length - 1].event.time : -Infinity;

    for (const ruleIdx of this.matchingRules(dev.id)) {
      const rule = this.rules[ruleIdx];
      const rs = this.freshRuleState(rule);
      const intervals = [];
      let current = null;
      const sink = {
        open: (t) => { current = { start: t, end: null }; intervals.push(current); },
        close: (t) => { current.end = t; },
      };
      // Evaluate once per distinct timestamp, after applying every event at
      // that time (matches the reference semantics for simultaneous events).
      let i = 0;
      while (i < dev.events.length) {
        const t = dev.events[i].event.time;
        this.settleBefore(rs, rule, t, sink);
        while (i < dev.events.length && dev.events[i].event.time === t) {
          rs.fields.set(dev.events[i].event.type, dev.events[i].event.value);
          i += 1;
        }
        this.evalAt(rs, rule, t, sink);
      }
      // Pending hold expiries beyond the last event are deliberately left
      // unfired here: they fire when a later event arrives or at the
      // end-of-input flush(). This keeps rs.lastTime inside the event
      // window so the fast path can safely continue from this state.

      let entries = dev.emitted.get(ruleIdx);
      if (!entries) dev.emitted.set(ruleIdx, (entries = []));
      this.diff(dev, ruleIdx, entries, intervals, changeTime);

      // Adopt the recomputed state as the live state, rebinding an open
      // alert to the id already emitted for its interval.
      if (rs.value && intervals.length) {
        const last = intervals[intervals.length - 1];
        const entry = entries.find((e) => e.alive && e.start === last.start && e.end === null);
        rs.openAlert = entry ? { id: entry.id, start: entry.start, entry } : null;
      }
      dev.rules.set(ruleIdx, rs);
    }
  }

  // Reconciles already-emitted alerts with the recomputed timeline so the
  // effective state matches a full replay. Intervals are matched by start
  // time: unchanged alerts are left alone (no duplicate triggers).
  diff(dev, ruleIdx, entries, intervals, changeTime) {
    const rule = this.rules[ruleIdx];
    for (const iv of intervals) {
      const match = entries.find((e) => e.alive && e.start === iv.start);
      if (!match) {
        const id = this.emitAlert(rule, dev.id, iv.start);
        entries.push({ id, start: iv.start, end: iv.end, alive: true });
        if (iv.end !== null) this.emitWithdraw(rule, dev.id, id, iv.end, 'recovered');
        continue;
      }
      if (match.end === iv.end) continue;
      if (match.end === null) {
        this.emitWithdraw(rule, dev.id, match.id, iv.end, 'recovered');
        match.end = iv.end;
      } else {
        // The close of an already-withdrawn alert moved (or was rescinded):
        // the latest withdraw supersedes the earlier one.
        this.emitWithdraw(rule, dev.id, match.id, iv.end, 'corrected');
        match.end = iv.end;
      }
    }
    for (const e of entries) {
      if (!e.alive) continue;
      if (intervals.some((iv) => iv.start === e.start)) continue;
      this.emitWithdraw(rule, dev.id, e.id, e.end === null ? changeTime : e.end, 'corrected');
      e.alive = false;
    }
  }
}
