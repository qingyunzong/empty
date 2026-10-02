import { EngineError } from './errors.js';
import { isPlainObject, validateCommand, validateFact, validateRule } from './validate.js';

const cmpStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function ordered(actual, operand) {
  return (
    typeof actual === typeof operand &&
    (typeof actual === 'number' || typeof actual === 'string')
  );
}

function matchValue(actual, matcher) {
  if (isPlainObject(matcher)) {
    if (actual === undefined) return false;
    for (const [op, operand] of Object.entries(matcher)) {
      switch (op) {
        case '$eq':
          if (actual !== operand) return false;
          break;
        case '$ne':
          if (actual === operand) return false;
          break;
        case '$gt':
          if (!ordered(actual, operand) || !(actual > operand)) return false;
          break;
        case '$gte':
          if (!ordered(actual, operand) || !(actual >= operand)) return false;
          break;
        case '$lt':
          if (!ordered(actual, operand) || !(actual < operand)) return false;
          break;
        case '$lte':
          if (!ordered(actual, operand) || !(actual <= operand)) return false;
          break;
        case '$in':
          if (!operand.some((v) => v === actual)) return false;
          break;
        default:
          return false;
      }
    }
    return true;
  }
  return actual === matcher;
}

function matchFact(matchObj, fact) {
  for (const [key, matcher] of Object.entries(matchObj)) {
    const actual = key === 'type' ? fact.type : key === 'id' ? fact.id : fact[key];
    if (!matchValue(actual, matcher)) return false;
  }
  return true;
}

function* enumerateSupports(conds, facts, proofsByAlarm) {
  const stack = [];
  function* go(i) {
    if (i === conds.length) {
      yield stack.flat();
      return;
    }
    const cond = conds[i];
    if (cond.fact !== undefined) {
      for (const fact of facts) {
        if (matchFact(cond.fact, fact)) {
          stack.push([fact.id]);
          yield* go(i + 1);
          stack.pop();
        }
      }
    } else {
      const bucket = proofsByAlarm.get(cond.alarm);
      if (bucket) {
        for (const proof of bucket.values()) {
          stack.push(proof.facts);
          yield* go(i + 1);
          stack.pop();
        }
      }
    }
  }
  yield* go(0);
}

function isStrictSubset(a, b) {
  return a.length < b.length && a.every((x) => b.includes(x));
}

function cmpFactLists(a, b, seqOf) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = seqOf.get(a[i]) - seqOf.get(b[i]);
    if (d !== 0) return d;
    const c = cmpStr(a[i], b[i]);
    if (c !== 0) return c;
  }
  return a.length - b.length;
}

export class Engine {
  #facts = new Map(); // id -> { fact, seq }
  #rules = new Map(); // id -> rule
  #seq = 0;
  #history = []; // snapshots for undo
  #dirty = true;
  #derived = null;

  constructor({ facts = [], rules = [] } = {}) {
    for (const fact of facts) {
      validateFact(fact);
      this.#checkDuplicate(this.#facts, fact.id, 'fact');
      this.#insertFact(fact);
    }
    for (const rule of rules) {
      validateRule(rule);
      this.#checkDuplicate(this.#rules, rule.id, 'rule');
      this.#insertRule(rule);
    }
  }

  #insertFact(fact) {
    this.#facts.set(fact.id, { fact: structuredClone(fact), seq: this.#seq++ });
    this.#dirty = true;
  }

  #insertRule(rule) {
    this.#rules.set(rule.id, structuredClone(rule));
    this.#dirty = true;
  }

  #checkDuplicate(map, id, kind) {
    if (map.has(id)) {
      throw new EngineError('DUPLICATE_ID', `duplicate ${kind} id "${id}"`, { kind, id });
    }
  }

  #snapshot() {
    this.#history.push({
      facts: structuredClone(new Map(this.#facts)),
      rules: structuredClone(new Map(this.#rules)),
      seq: this.#seq,
    });
  }

  run(command) {
    validateCommand(command);
    switch (command.cmd) {
      case 'append': {
        this.#checkDuplicate(this.#facts, command.fact.id, 'fact');
        this.#snapshot();
        this.#insertFact(command.fact);
        break;
      }
      case 'retract': {
        if (!this.#facts.has(command.id)) {
          throw new EngineError('UNKNOWN_FACT', `unknown fact id "${command.id}"`, {
            id: command.id,
          });
        }
        this.#snapshot();
        this.#facts.delete(command.id);
        this.#dirty = true;
        break;
      }
      case 'addRule': {
        this.#checkDuplicate(this.#rules, command.rule.id, 'rule');
        this.#snapshot();
        this.#insertRule(command.rule);
        break;
      }
      case 'removeRule': {
        if (!this.#rules.has(command.id)) {
          throw new EngineError('UNKNOWN_RULE', `unknown rule id "${command.id}"`, {
            id: command.id,
          });
        }
        this.#snapshot();
        this.#rules.delete(command.id);
        this.#dirty = true;
        break;
      }
      case 'undo': {
        if (this.#history.length === 0) {
          throw new EngineError('EMPTY_HISTORY', 'nothing to undo');
        }
        const snap = this.#history.pop();
        this.#facts = snap.facts;
        this.#rules = snap.rules;
        this.#seq = snap.seq;
        this.#dirty = true;
        break;
      }
    }
    return this.getState();
  }

  // Rule dependency graph: ruleId -> sorted ruleIds whose conclusions it consumes.
  dependencies() {
    const byAlarm = new Map();
    for (const rule of this.#rules.values()) {
      if (!byAlarm.has(rule.derive.alarm)) byAlarm.set(rule.derive.alarm, []);
      byAlarm.get(rule.derive.alarm).push(rule.id);
    }
    const deps = {};
    const sorted = [...this.#rules.values()].sort((a, b) => cmpStr(a.id, b.id));
    for (const rule of sorted) {
      const set = new Set();
      for (const cond of rule.when) {
        if (cond.alarm !== undefined) {
          for (const rid of byAlarm.get(cond.alarm) ?? []) set.add(rid);
        }
      }
      deps[rule.id] = [...set].sort(cmpStr);
    }
    return deps;
  }

  // Deterministic least-fixpoint replay over the full history of live facts.
  #derive() {
    const entries = [...this.#facts.values()].sort((a, b) => a.seq - b.seq);
    const facts = entries.map((e) => e.fact);
    const seqOf = new Map(entries.map((e) => [e.fact.id, e.seq]));
    const rules = [...this.#rules.values()].sort((a, b) => cmpStr(a.id, b.id));

    const proofsByAlarm = new Map(); // alarm -> Map key -> { rule, facts }
    let changed = true;
    while (changed) {
      changed = false;
      for (const rule of rules) {
        for (const support of enumerateSupports(rule.when, facts, proofsByAlarm)) {
          const ids = [...new Set(support)].sort(
            (a, b) => seqOf.get(a) - seqOf.get(b) || cmpStr(a, b),
          );
          const key = rule.id + '|' + ids.join(',');
          let bucket = proofsByAlarm.get(rule.derive.alarm);
          if (!bucket) {
            bucket = new Map();
            proofsByAlarm.set(rule.derive.alarm, bucket);
          }
          if (!bucket.has(key)) {
            bucket.set(key, { rule: rule.id, facts: ids });
            changed = true;
          }
        }
      }
    }

    const alarms = [];
    for (const [name, bucket] of proofsByAlarm) {
      const all = [...bucket.values()];
      const minimal = all.filter(
        (p) => !all.some((q) => q !== p && isStrictSubset(q.facts, p.facts)),
      );
      minimal.sort((a, b) => cmpStr(a.rule, b.rule) || cmpFactLists(a.facts, b.facts, seqOf));
      alarms.push({ alarm: name, proofs: minimal });
    }
    const sortKey = (a) => [
      a.proofs[0].rule,
      Math.min(...a.proofs.flatMap((p) => p.facts.map((f) => seqOf.get(f)))),
    ];
    alarms.sort((x, y) => {
      const [rx, sx] = sortKey(x);
      const [ry, sy] = sortKey(y);
      return cmpStr(rx, ry) || sx - sy || cmpStr(x.alarm, y.alarm);
    });
    return alarms;
  }

  getState() {
    if (this.#dirty) {
      this.#derived = this.#derive();
      this.#dirty = false;
    }
    return {
      alarms: structuredClone(this.#derived),
      facts: [...this.#facts.values()]
        .sort((a, b) => a.seq - b.seq)
        .map((e) => ({ seq: e.seq, ...structuredClone(e.fact) })),
      rules: [...this.#rules.values()]
        .sort((a, b) => cmpStr(a.id, b.id))
        .map((r) => structuredClone(r)),
      dependencies: this.dependencies(),
    };
  }
}
