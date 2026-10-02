import {
  evalPred,
  emptyAggState,
  aggStateOfRow,
  combineAggState,
  finalizeAgg,
  compare,
} from './algebra.js';
import { canonical } from './canonical.js';

// Beyond this many simultaneously pending rows, evaluation falls back to a
// conservative 'undecided' instead of enumerating 2^k completions.
export const MAX_PENDING = 20;

// Three-valued claim evaluation over completions.
//
// Asserted rows matching the claim selection (and not excluded by a rule)
// form the certain base. Unknown or retracted rows whose selection result is
// not definitely false are "pending": each may or may not hold. The engine
// enumerates every completion (subset) of the pending set; the conclusion is
// 'pass' only if every completion satisfies the claim comparison, 'fail' only
// if every completion violates it, otherwise 'undecided'. Unknown evidence is
// therefore never silently treated as unsatisfiable, and retracting local
// evidence degrades a pass to undecided rather than fail.
//
// Results are cached with their dependency key set; a retraction invalidates
// only claims whose dependency set contains the retracted key, so no full
// rescan of the evidence base is needed for unaffected claims.
export class Engine {
  constructor(store) {
    this.store = store;
    this.cache = new Map(); // canonicalClaim -> { result, deps:Set }
    this.stats = { evaluations: 0, cacheHits: 0, invalidations: 0 };
  }

  retract(key) {
    this.store.retract(key); // O(1); throws E_EVIDENCE_GONE when absent
    for (const [claimKey, entry] of this.cache) {
      if (entry.deps.has(key)) {
        this.cache.delete(claimKey);
        this.stats.invalidations += 1;
      }
    }
  }

  evaluate(claim) {
    const claimKey = canonical(claim);
    const cached = this.cache.get(claimKey);
    if (cached) {
      this.stats.cacheHits += 1;
      return cached.result;
    }
    this.stats.evaluations += 1;
    const result = this.#compute(claim);
    this.cache.set(claimKey, { result, deps: new Set(result.relevantKeys) });
    return result;
  }

  #compute(claim) {
    const store = this.store;
    const select = claim.select ?? { op: 'true' };
    const agg = claim.aggregate ?? { op: 'count', field: '*' };

    const included = []; // asserted, selected, not rule-excluded
    const pendingRows = []; // unknown/retracted, possibly selected
    const excludedByRule = new Map(); // ruleId -> [keys]
    const relevantKeys = [];

    for (const row of store.all()) {
      const p = evalPred(select, row.fields);
      if (row.status === 'asserted') {
        if (p !== true) continue;
        relevantKeys.push(row.key);
        const hits = store.rulesMatching(row.key);
        if (hits.length === 0) {
          included.push(row);
        } else {
          for (const rule of hits) {
            if (!excludedByRule.has(rule.id)) excludedByRule.set(rule.id, []);
            excludedByRule.get(rule.id).push(row.key);
          }
        }
      } else if (p !== false) {
        // unknown/retracted row that may match: a pending completion branch
        relevantKeys.push(row.key);
        if (store.rulesMatching(row.key).length === 0) pendingRows.push(row);
      }
    }

    const fired = [...excludedByRule.keys()];
    let appliedRules = [];
    if (fired.length > 0) {
      const best = Math.max(...fired.map((id) => store.rules.get(id).priority));
      appliedRules = fired.filter((id) => store.rules.get(id).priority === best).sort();
    }

    let base = emptyAggState();
    for (const row of included) base = combineAggState(base, aggStateOfRow(agg, row));

    const outcomes = new Set();
    const k = pendingRows.length;
    if (k > MAX_PENDING) {
      outcomes.add('unknown'); // conservative: too many pending branches
    } else {
      const pendingStates = pendingRows.map((row) => aggStateOfRow(agg, row));
      for (let mask = 0; mask < 1 << k; mask += 1) {
        let state = base;
        for (let i = 0; i < k; i += 1) {
          if ((mask >> i) & 1) state = combineAggState(state, pendingStates[i]);
        }
        const c = compare(finalizeAgg(agg, state), claim.cmp);
        outcomes.add(c === null ? 'unknown' : String(c));
        if ((outcomes.has('true') && outcomes.has('false'))
          || (outcomes.has('unknown') && outcomes.size > 1)) break;
      }
    }

    const conclusion =
      outcomes.size === 1 && outcomes.has('true')
        ? 'pass'
        : outcomes.size === 1 && outcomes.has('false')
          ? 'fail'
          : 'undecided';

    const sortObj = (m) =>
      Object.fromEntries([...m.entries()].map(([id, keys]) => [id, [...keys].sort()]).sort());

    return {
      conclusion,
      aggregate: finalizeAgg(agg, base),
      hitEvidenceKeys: included.map((r) => r.key).sort(),
      undecided: pendingRows.map((r) => r.key).sort(),
      excludedByRule: sortObj(excludedByRule),
      appliedRules,
      relevantKeys: relevantKeys.sort(),
    };
  }
}
