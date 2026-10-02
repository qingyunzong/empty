// Independent naive reference implementation.
//
// Unlike src/engine.js (fact indexes, dependency graph, incremental
// invalidation), this module performs a brute-force fixpoint enumeration:
// it repeatedly scans every rule against every event/alarm combination
// until no new proof appears, then minimizes. It exists to cross-check the
// incremental engine on small instances.

const COMPARE = {
  '<': (a, b) => a < b,
  '<=': (a, b) => a <= b,
  '>': (a, b) => a > b,
  '>=': (a, b) => a >= b,
  '==': (a, b) => a === b,
  '!=': (a, b) => a !== b,
};

function matchEvent(event, cond) {
  if (event.type !== cond.type) return false;
  if (cond.op === undefined) return true;
  return typeof event.value === 'number' && COMPARE[cond.op](event.value, cond.value);
}

function flatten(proof, out) {
  for (const fact of proof.facts) out.add(fact);
  for (const sub of proof.alarms) flatten(sub.proof, out);
  return out;
}

function canonical(proof) {
  return JSON.stringify({
    rule: proof.rule,
    facts: proof.facts,
    alarms: proof.alarms.map((sub) => [sub.alarm, canonical(sub.proof)]),
  });
}

function properSubset(a, b) {
  if (a.size >= b.size) return false;
  for (const item of a) if (!b.has(item)) return false;
  return true;
}

export function referenceSnapshot(events, rules) {
  const seqOf = new Map(events.map((event) => [event.id, event.seq]));
  const cmpIds = (a, b) => {
    const sa = seqOf.get(a);
    const sb = seqOf.get(b);
    if (sa !== sb) return sa - sb;
    return a < b ? -1 : a > b ? 1 : 0;
  };
  const sortedEvents = [...events].sort((x, y) => cmpIds(x.id, y.id));

  const normalize = (proof) => ({
    rule: proof.rule,
    facts: [...new Set(proof.facts)].sort(cmpIds),
    alarms: proof.alarms
      .map((sub) => ({ alarm: sub.alarm, proof: sub.proof }))
      .sort((x, y) => {
        if (x.alarm !== y.alarm) return x.alarm < y.alarm ? -1 : 1;
        const cx = canonical(x.proof);
        const cy = canonical(y.proof);
        return cx < cy ? -1 : cx > cy ? 1 : 0;
      }),
  });

  const alarms = new Map();
  let changed = true;
  while (changed) {
    changed = false;
    for (const rule of rules) {
      let combos = [{ facts: [], alarms: [] }];
      for (const cond of rule.when) {
        const next = [];
        if (cond.type !== undefined) {
          for (const combo of combos) {
            for (const event of sortedEvents) {
              if (matchEvent(event, cond)) {
                next.push({ facts: [...combo.facts, event.id], alarms: combo.alarms });
              }
            }
          }
        } else {
          const sub = alarms.get(cond.alarm);
          if (sub) {
            for (const combo of combos) {
              for (const subProof of sub) {
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
      for (const combo of combos) {
        const proof = normalize({ rule: rule.id, facts: combo.facts, alarms: combo.alarms });
        const list = alarms.get(rule.alarm) ?? [];
        const key = canonical(proof);
        if (!list.some((existing) => canonical(existing) === key)) {
          list.push(proof);
          alarms.set(rule.alarm, list);
          changed = true;
        }
      }
    }
  }

  const cmpProofs = (a, b) => {
    if (a.rule !== b.rule) return a.rule < b.rule ? -1 : 1;
    const fa = [...flatten(a, new Set())].sort(cmpIds);
    const fb = [...flatten(b, new Set())].sort(cmpIds);
    for (let i = 0; i < Math.min(fa.length, fb.length); i += 1) {
      const cmp = cmpIds(fa[i], fb[i]);
      if (cmp !== 0) return cmp;
    }
    if (fa.length !== fb.length) return fa.length - fb.length;
    const ca = canonical(a);
    const cb = canonical(b);
    return ca < cb ? -1 : ca > cb ? 1 : 0;
  };

  const names = [...alarms.keys()].sort();
  const result = [];
  for (const name of names) {
    const proofs = alarms.get(name);
    const flats = proofs.map((proof) => flatten(proof, new Set()));
    const kept = proofs.filter((_, i) =>
      !proofs.some((__, j) => j !== i && properSubset(flats[j], flats[i])),
    );
    const seen = new Set();
    const minimal = [];
    for (const proof of kept) {
      const key = canonical(proof);
      if (seen.has(key)) continue;
      seen.add(key);
      minimal.push(proof);
    }
    minimal.sort(cmpProofs);
    if (minimal.length > 0) result.push({ alarm: name, proofs: minimal });
  }
  return result;
}
