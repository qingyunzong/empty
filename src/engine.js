// Incremental engine: feeds input records through the shared EventStore and,
// after each mutation, re-evaluates only the affected devices' windows via
// the bytecode VM, diffing the open-alert set to emit alert/withdraw records.
// Because evaluation is a pure function of the store, the folded record
// stream always equals the naive full replay of the same final store.

import { EventStore } from './store.js';
import { evaluateRule } from './vm.js';
import { matchesDevice } from './compiler.js';

export class Engine {
  constructor(rules) {
    this.rules = rules;
    this.store = new EventStore();
    this.records = [];
    this.seq = 0;
    // key `${rule} ${device}` -> array of open alert start times
    this.active = new Map();
  }

  get errors() {
    return this.store.errors;
  }

  process(record, seq) {
    if (seq === undefined) seq = this.seq + 1;
    this.seq = seq;
    const applied = this.store.apply(record, seq);
    if (!applied) return;
    for (const device of applied.affected) {
      this.recomputeDevice(device, applied.reason, applied.time, seq);
    }
  }

  processAll(records) {
    for (const record of records) this.process(record);
  }

  recomputeDevice(device, reason, causeTime, seq) {
    const events = this.store.eventsFor(device);
    for (const rule of this.rules) {
      const key = `${rule.name} ${device}`;
      const prev = this.active.get(key) ?? [];
      if (!matchesDevice(rule, device)) {
        if (prev.length) this.active.delete(key);
        continue;
      }
      const intervals = evaluateRule(rule.program, events);
      const open = intervals.filter((a) => a.end === null).map((a) => a.at);
      const closedEndByAt = new Map();
      for (const a of intervals) {
        if (a.end !== null) closedEndByAt.set(a.at, a.end);
      }
      const withdrawn = prev.filter((at) => !open.includes(at)).sort((a, b) => a - b);
      const raised = open.filter((at) => !prev.includes(at)).sort((a, b) => a - b);
      for (const at of withdrawn) {
        this.records.push({
          type: 'withdraw',
          rule: rule.name,
          level: rule.level,
          device,
          alertAt: at,
          at: closedEndByAt.get(at) ?? causeTime ?? null,
          reason,
          seq,
        });
      }
      for (const at of raised) {
        this.records.push({
          type: 'alert',
          rule: rule.name,
          level: rule.level,
          device,
          at,
          seq,
        });
      }
      if (open.length) this.active.set(key, open);
      else this.active.delete(key);
    }
  }

  // Currently active alerts as a comparable, sorted list.
  activeAlerts() {
    const out = [];
    for (const [key, ats] of this.active) {
      const sep = key.indexOf(' ');
      const rule = key.slice(0, sep);
      const device = key.slice(sep + 1);
      for (const at of ats) out.push({ rule, device, at });
    }
    out.sort((a, b) => a.rule.localeCompare(b.rule) || a.device.localeCompare(b.device) || a.at - b.at);
    return out;
  }
}
