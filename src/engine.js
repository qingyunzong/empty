import { AlarmError } from './errors.js';
import { validateEvent, validateRule, validateOp } from './schema.js';

const COMPARE = {
  '<': (a, b) => a < b,
  '<=': (a, b) => a <= b,
  '>': (a, b) => a > b,
  '>=': (a, b) => a >= b,
  '==': (a, b) => a === b,
  '!=': (a, b) => a !== b,
};

function addTo(map, key, value) {
  let set = map.get(key);
  if (!set) {
    set = new Set();
    map.set(key, set);
  }
  set.add(value);
}

function deleteFrom(map, key, value) {
  const set = map.get(key);
  if (!set) return;
  set.delete(value);
  if (set.size === 0) map.delete(key);
}

function flattenFacts(proof, out = new Set()) {
  for (const fact of proof.facts) out.add(fact);
  for (const sub of proof.alarms) flattenFacts(sub.proof, out);
  return out;
}

function canonicalProof(proof) {
  return JSON.stringify({
    rule: proof.rule,
    facts: proof.facts,
    alarms: proof.alarms.map((sub) => [sub.alarm, canonicalProof(sub.proof)]),
  });
}

function isProperSubset(a, b) {
  if (a.size >= b.size) return false;
  for (const item of a) if (!b.has(item)) return false;
  return true;
}

export class AlarmEngine {
  constructor() {
    this.events = new Map();
    this.seqIndex = new Map();
    this.typeIndex = new Map();
    this.rules = new Map();
    this.rulesByAlarm = new Map();
    this.alarmConsumers = new Map();
    this.alarms = new Map();
    this.factUse = new Map();
    this.history = [];
  }

  loadRules(rawRules) {
    if (!Array.isArray(rawRules)) {
      throw new AlarmError('BAD_INPUT', 'rules must be an array', { value: rawRules });
    }
    const validated = rawRules.map(validateRule);
    const seen = new Set();
    for (const rule of validated) {
      if (seen.has(rule.id) || this.rules.has(rule.id)) {
        throw new AlarmError('DUPLICATE_ID', `duplicate rule id "${rule.id}"`, { id: rule.id });
      }
      seen.add(rule.id);
    }
    for (const rule of validated) this._addRule(rule, false);
  }

  applyOp(rawOp) {
    const op = validateOp(rawOp);
    let result;
    switch (op.op) {
      case 'append':
        result = this._append(op.event, true);
        break;
      case 'retract':
        result = this._retract(op.id, true);
        break;
      case 'addRule':
        result = this._addRule(op.rule, true);
        break;
      case 'removeRule':
        result = this._removeRule(op.id, true);
        break;
      case 'undo':
        result = this.undo();
        break;
      default:
        throw new AlarmError('UNKNOWN_OP', `unknown command "${String(op.op)}"`, { op: op.op });
    }
    return { op: op.op, ...result };
  }

  undo() {
    const inverse = this.history.pop();
    if (!inverse) {
      throw new AlarmError('NOTHING_TO_UNDO', 'history is empty, nothing to undo', null);
    }
    switch (inverse.op) {
      case 'append':
        return this._append(inverse.event, false);
      case 'retract':
        return this._retract(inverse.id, false);
      case 'addRule':
        return this._addRule(inverse.rule, false);
      case 'removeRule':
        return this._removeRule(inverse.id, false);
      default:
        throw new AlarmError('INTERNAL', `bad history entry "${String(inverse.op)}"`, null);
    }
  }

  snapshot() {
    return [...this.alarms.keys()].sort().map((name) => ({
      alarm: name,
      proofs: structuredClone(this.alarms.get(name).proofs),
    }));
  }

  _append(event, record) {
    if (this.events.has(event.id)) {
      throw new AlarmError('DUPLICATE_ID', `duplicate event id "${event.id}"`, { id: event.id });
    }
    if (this.seqIndex.has(event.seq)) {
      throw new AlarmError('DUPLICATE_SEQ', `duplicate event seq ${event.seq}`, { seq: event.seq });
    }
    this.events.set(event.id, event);
    this.seqIndex.set(event.seq, event.id);
    addTo(this.typeIndex, event.type, event.id);
    const affected = new Set();
    for (const rule of this.rules.values()) {
      if (rule.when.some((cond) => cond.type === event.type)) affected.add(rule.alarm);
    }
    const result = this._recompute(affected);
    if (record) this.history.push({ op: 'retract', id: event.id });
    return result;
  }

  _retract(id, record) {
    const event = this.events.get(id);
    if (!event) {
      throw new AlarmError('UNKNOWN_EVENT', `unknown event id "${id}"`, { id });
    }
    const affected = new Set(this.factUse.get(id) ?? []);
    this.events.delete(id);
    this.seqIndex.delete(event.seq);
    deleteFrom(this.typeIndex, event.type, id);
    const result = this._recompute(affected);
    if (record) this.history.push({ op: 'append', event });
    return result;
  }

  _addRule(rule, record) {
    if (this.rules.has(rule.id)) {
      throw new AlarmError('DUPLICATE_ID', `duplicate rule id "${rule.id}"`, { id: rule.id });
    }
    this._checkCycle(rule);
    this.rules.set(rule.id, rule);
    addTo(this.rulesByAlarm, rule.alarm, rule.id);
    for (const cond of rule.when) {
      if (cond.alarm !== undefined) addTo(this.alarmConsumers, cond.alarm, rule.id);
    }
    const result = this._recompute(new Set([rule.alarm]));
    if (record) this.history.push({ op: 'removeRule', id: rule.id });
    return result;
  }

  _removeRule(id, record) {
    const rule = this.rules.get(id);
    if (!rule) {
      throw new AlarmError('UNKNOWN_RULE', `unknown rule id "${id}"`, { id });
    }
    this.rules.delete(id);
    deleteFrom(this.rulesByAlarm, rule.alarm, id);
    for (const cond of rule.when) {
      if (cond.alarm !== undefined) deleteFrom(this.alarmConsumers, cond.alarm, id);
    }
    const result = this._recompute(new Set([rule.alarm]));
    if (record) this.history.push({ op: 'addRule', rule });
    return result;
  }

  _checkCycle(rule) {
    const seen = new Set();
    const queue = rule.when.filter((cond) => cond.alarm !== undefined).map((cond) => cond.alarm);
    while (queue.length > 0) {
      const name = queue.pop();
      if (name === rule.alarm) {
        throw new AlarmError(
          'RULE_CYCLE',
          `rule "${rule.id}" would close a dependency cycle on alarm "${name}"`,
          { rule: rule.id, alarm: name },
        );
      }
      if (seen.has(name)) continue;
      seen.add(name);
      for (const dep of this._depsOf(name)) queue.push(dep);
    }
  }

  _depsOf(name) {
    const deps = new Set();
    for (const ruleId of this.rulesByAlarm.get(name) ?? []) {
      for (const cond of this.rules.get(ruleId).when) {
        if (cond.alarm !== undefined) deps.add(cond.alarm);
      }
    }
    return deps;
  }

  _downstream(names) {
    const seen = new Set(names);
    const queue = [...names];
    while (queue.length > 0) {
      const name = queue.shift();
      for (const ruleId of this.alarmConsumers.get(name) ?? []) {
        const conclusion = this.rules.get(ruleId).alarm;
        if (!seen.has(conclusion)) {
          seen.add(conclusion);
          queue.push(conclusion);
        }
      }
    }
    return seen;
  }

  _topoOrder(names) {
    const indegree = new Map();
    const dependents = new Map();
    for (const name of names) indegree.set(name, 0);
    for (const name of names) {
      for (const dep of this._depsOf(name)) {
        if (!names.has(dep)) continue;
        indegree.set(name, indegree.get(name) + 1);
        addTo(dependents, dep, name);
      }
    }
    const ready = [...names].filter((name) => indegree.get(name) === 0).sort();
    const order = [];
    while (ready.length > 0) {
      const name = ready.shift();
      order.push(name);
      for (const next of [...(dependents.get(name) ?? [])].sort()) {
        indegree.set(next, indegree.get(next) - 1);
        if (indegree.get(next) === 0) {
          ready.push(next);
          ready.sort();
        }
      }
    }
    if (order.length !== names.size) {
      throw new AlarmError('RULE_CYCLE', 'rule dependency cycle detected', null);
    }
    return order;
  }

  _recompute(affected) {
    const closure = this._downstream(affected);
    const order = this._topoOrder(closure);
    const added = [];
    const removed = [];
    for (const name of order) {
      const had = this.alarms.has(name);
      this._deindexAlarm(name);
      const proofs = this._deriveAlarm(name);
      if (proofs.length === 0) {
        if (had) {
          this.alarms.delete(name);
          removed.push(name);
        }
      } else {
        this.alarms.set(name, { alarm: name, proofs });
        this._indexAlarm(name, proofs);
        if (!had) added.push(name);
      }
    }
    added.sort();
    removed.sort();
    return { added, removed };
  }

  _indexAlarm(name, proofs) {
    for (const proof of proofs) {
      for (const fact of flattenFacts(proof)) addTo(this.factUse, fact, name);
    }
  }

  _deindexAlarm(name) {
    const entry = this.alarms.get(name);
    if (!entry) return;
    for (const proof of entry.proofs) {
      for (const fact of flattenFacts(proof)) deleteFrom(this.factUse, fact, name);
    }
  }

  _matchFact(cond) {
    const ids = [];
    for (const id of this.typeIndex.get(cond.type) ?? []) {
      const event = this.events.get(id);
      if (cond.op === undefined) {
        ids.push(id);
      } else if (typeof event.value === 'number' && COMPARE[cond.op](event.value, cond.value)) {
        ids.push(id);
      }
    }
    ids.sort((a, b) => this._cmpEventIds(a, b));
    return ids;
  }

  _cmpEventIds(a, b) {
    const ea = this.events.get(a);
    const eb = this.events.get(b);
    if (ea.seq !== eb.seq) return ea.seq - eb.seq;
    return a < b ? -1 : a > b ? 1 : 0;
  }

  _deriveAlarm(name) {
    const proofs = [];
    const ruleIds = [...(this.rulesByAlarm.get(name) ?? [])].sort();
    for (const ruleId of ruleIds) {
      const rule = this.rules.get(ruleId);
      let combos = [{ facts: [], alarms: [] }];
      for (const cond of rule.when) {
        const next = [];
        if (cond.type !== undefined) {
          const ids = this._matchFact(cond);
          for (const combo of combos) {
            for (const id of ids) {
              next.push({ facts: [...combo.facts, id], alarms: combo.alarms });
            }
          }
        } else {
          const sub = this.alarms.get(cond.alarm);
          if (sub) {
            for (const combo of combos) {
              for (const subProof of sub.proofs) {
                next.push({
                  facts: combo.facts,
                  alarms: [...combo.alarms, { alarm: cond.alarm, proof: subProof }],
                });
              }
            }
          }
        }
        combos = next;
        if (combos.length === 0) break;
      }
      for (const combo of combos) proofs.push(this._makeProof(ruleId, combo));
    }
    return this._finalize(proofs);
  }

  _makeProof(ruleId, combo) {
    const facts = [...new Set(combo.facts)].sort((a, b) => this._cmpEventIds(a, b));
    const alarms = combo.alarms
      .map((sub) => ({ alarm: sub.alarm, proof: sub.proof }))
      .sort((x, y) => {
        if (x.alarm !== y.alarm) return x.alarm < y.alarm ? -1 : 1;
        const cx = canonicalProof(x.proof);
        const cy = canonicalProof(y.proof);
        return cx < cy ? -1 : cx > cy ? 1 : 0;
      });
    return { rule: ruleId, facts, alarms };
  }

  _finalize(proofs) {
    const flats = proofs.map((proof) => flattenFacts(proof));
    const kept = proofs.filter((_, i) =>
      !proofs.some((__, j) => j !== i && isProperSubset(flats[j], flats[i])),
    );
    const seen = new Set();
    const out = [];
    for (const proof of kept) {
      const key = canonicalProof(proof);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(proof);
    }
    out.sort((a, b) => this._cmpProofs(a, b));
    return out;
  }

  _cmpProofs(a, b) {
    if (a.rule !== b.rule) return a.rule < b.rule ? -1 : 1;
    const fa = [...flattenFacts(a)].sort((x, y) => this._cmpEventIds(x, y));
    const fb = [...flattenFacts(b)].sort((x, y) => this._cmpEventIds(x, y));
    for (let i = 0; i < Math.min(fa.length, fb.length); i += 1) {
      const cmp = this._cmpEventIds(fa[i], fb[i]);
      if (cmp !== 0) return cmp;
    }
    if (fa.length !== fb.length) return fa.length - fb.length;
    const ca = canonicalProof(a);
    const cb = canonicalProof(b);
    return ca < cb ? -1 : ca > cb ? 1 : 0;
  }
}
