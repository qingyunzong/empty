// Independent naive reference implementation used only by the tests.
// Straightforward least-fixpoint enumeration: no indexes, no caching,
// proofs are re-derived from scratch on every call.

function isObj(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function matchValue(actual, matcher) {
  if (isObj(matcher)) {
    if (actual === undefined) return false;
    for (const [op, operand] of Object.entries(matcher)) {
      if (op === '$eq' && actual !== operand) return false;
      if (op === '$ne' && actual === operand) return false;
      if (op === '$gt' && !(typeof actual === typeof operand && actual > operand)) return false;
      if (op === '$gte' && !(typeof actual === typeof operand && actual >= operand)) return false;
      if (op === '$lt' && !(typeof actual === typeof operand && actual < operand)) return false;
      if (op === '$lte' && !(typeof actual === typeof operand && actual <= operand)) return false;
      if (op === '$in' && !operand.some((v) => v === actual)) return false;
    }
    return true;
  }
  return actual === matcher;
}

function matchFact(matchObj, fact) {
  return Object.entries(matchObj).every(([key, matcher]) => {
    const actual = key === 'type' ? fact.type : key === 'id' ? fact.id : fact[key];
    return matchValue(actual, matcher);
  });
}

// Cartesian-style enumeration of all supports for a conjunction.
function enumerate(conds, facts, proofsByAlarm) {
  let partials = [[]];
  for (const cond of conds) {
    const next = [];
    if (cond.fact !== undefined) {
      for (const partial of partials) {
        for (const fact of facts) {
          if (matchFact(cond.fact, fact)) next.push([...partial, fact.id]);
        }
      }
    } else {
      const proofs = proofsByAlarm.get(cond.alarm) ?? [];
      for (const partial of partials) {
        for (const proof of proofs) {
          next.push([...partial, ...proof.facts]);
        }
      }
    }
    partials = next;
  }
  return partials;
}

function sameSet(a, b) {
  return a.length === b.length && a.every((x) => b.includes(x));
}

function strictSubset(a, b) {
  return a.length < b.length && a.every((x) => b.includes(x));
}

// facts: array in append order; rules: array in any order.
// Returns Map alarmName -> [{ rule, facts: [ids sorted by append order] }] (minimal only).
export function naiveDerive(facts, rules) {
  const order = new Map(facts.map((f, i) => [f.id, i]));
  const proofsByAlarm = new Map(); // alarm -> [{ rule, facts }]
  let changed = true;
  while (changed) {
    changed = false;
    for (const rule of rules) {
      for (const support of enumerate(rule.when, facts, proofsByAlarm)) {
        const ids = [...new Set(support)].sort((a, b) => order.get(a) - order.get(b));
        const list = proofsByAlarm.get(rule.derive.alarm) ?? [];
        if (!list.some((p) => p.rule === rule.id && sameSet(p.facts, ids))) {
          list.push({ rule: rule.id, facts: ids });
          proofsByAlarm.set(rule.derive.alarm, list);
          changed = true;
        }
      }
    }
  }
  const result = new Map();
  for (const [alarm, list] of proofsByAlarm) {
    result.set(
      alarm,
      list.filter((p) => !list.some((q) => q !== p && strictSubset(q.facts, p.facts))),
    );
  }
  return result;
}

// Normalized, order-independent projection for comparisons.
export function normalizeAlarms(alarms) {
  const out = {};
  for (const a of alarms) {
    out[a.alarm] = a.proofs
      .map((p) => ({ rule: p.rule, facts: [...p.facts] }))
      .sort((x, y) =>
        x.rule < y.rule ? -1 : x.rule > y.rule ? 1 : x.facts.join('').localeCompare(y.facts.join('')),
      );
  }
  return out;
}

export function normalizeNaive(map) {
  const out = {};
  for (const [alarm, proofs] of map) {
    out[alarm] = proofs
      .map((p) => ({ rule: p.rule, facts: [...p.facts] }))
      .sort((x, y) =>
        x.rule < y.rule ? -1 : x.rule > y.rule ? 1 : x.facts.join('').localeCompare(y.facts.join('')),
      );
  }
  return out;
}
