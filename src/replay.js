// Naive full-replay reference: applies the whole input stream to a fresh
// store, then evaluates every device once and derives the record stream from
// the final alert intervals. Used by the CLI tests as the ground truth that
// the incremental engine must agree with.

import { EventStore } from './store.js';
import { evaluateRule } from './vm.js';
import { matchesDevice } from './compiler.js';

export function fullReplay(records, rules) {
  const store = new EventStore();
  let seq = 0;
  for (const record of records) {
    seq += 1;
    store.apply(record, seq);
  }

  const out = [];
  for (const device of store.devices()) {
    const events = store.eventsFor(device);
    for (const rule of rules) {
      if (!matchesDevice(rule, device)) continue;
      for (const interval of evaluateRule(rule.program, events)) {
        out.push({
          type: 'alert',
          rule: rule.name,
          level: rule.level,
          device,
          at: interval.at,
        });
        if (interval.end !== null) {
          out.push({
            type: 'withdraw',
            rule: rule.name,
            level: rule.level,
            device,
            alertAt: interval.at,
            at: interval.end,
            reason: 'recovered',
          });
        }
      }
    }
  }
  out.sort((a, b) =>
    (a.at ?? 0) - (b.at ?? 0) ||
    a.rule.localeCompare(b.rule) ||
    a.device.localeCompare(b.device) ||
    (a.type === b.type ? 0 : a.type === 'withdraw' ? -1 : 1));
  return { records: out, errors: store.errors };
}

// Folds a record stream into the set of currently active alerts.
export function foldActive(records) {
  const active = new Map();
  for (const rec of records) {
    const key = `${rec.rule} ${rec.device}`;
    if (rec.type === 'alert') {
      const set = active.get(key) ?? new Set();
      set.add(rec.at);
      active.set(key, set);
    } else if (rec.type === 'withdraw') {
      const set = active.get(key);
      if (set) {
        set.delete(rec.alertAt);
        if (set.size === 0) active.delete(key);
      }
    }
  }
  const out = [];
  for (const [key, ats] of active) {
    const sep = key.indexOf(' ');
    for (const at of ats) out.push({ rule: key.slice(0, sep), device: key.slice(sep + 1), at });
  }
  out.sort((a, b) => a.rule.localeCompare(b.rule) || a.device.localeCompare(b.device) || a.at - b.at);
  return out;
}
