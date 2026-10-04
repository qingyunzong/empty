import { validateQuery, QueryError } from './query.js';
import { optimize } from './planner.js';
import { executePlan, hashRows } from './executor.js';

function stableKey(value) {
  if (Array.isArray(value)) return `[${value.map(stableKey).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableKey(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function deepMerge(target, patch) {
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && target[k] && typeof target[k] === 'object') {
      deepMerge(target[k], v);
    } else {
      target[k] = v;
    }
  }
  return target;
}

export class Engine {
  constructor(catalog, data = {}) {
    this.catalog = structuredClone(catalog);
    this.data = data;
    this.cache = new Map(); // stableKey(query) -> { query, plan, planString, cost, tables }
  }

  explain(query) {
    const key = stableKey(query);
    let entry = this.cache.get(key);
    if (!entry) {
      const q = validateQuery(query, this.catalog);
      const best = optimize(q, this.catalog);
      entry = {
        query: q,
        plan: best.plan,
        planString: best.planString,
        cost: best.cost,
        tables: [q.scan, ...q.joins.map((j) => j.table)],
      };
      this.cache.set(key, entry);
    }
    return { plan: entry.plan, planString: entry.planString, cost: entry.cost };
  }

  execute(query) {
    const explained = this.explain(query);
    const rows = executePlan(explained.plan, this.data, this.catalog);
    return { ...explained, rows, hash: hashRows(rows) };
  }

  // Merges new statistics for one table into the catalog and invalidates
  // only cached plans that reference that table. Returns old/new plan,
  // cost and result-hash delta for every affected cached query.
  updateStats(table, stats) {
    const tdef = this.catalog.tables[table];
    if (!tdef) throw new QueryError(`unknown table: ${table}`);
    deepMerge(tdef, stats);
    const affected = [];
    for (const [key, entry] of [...this.cache]) {
      if (!entry.tables.includes(table)) continue;
      const oldHash = hashRows(executePlan(entry.plan, this.data, this.catalog));
      this.cache.delete(key);
      const next = this.explain(entry.query);
      const newHash = hashRows(executePlan(next.plan, this.data, this.catalog));
      affected.push({
        query: entry.query,
        oldPlan: entry.planString,
        oldCost: entry.cost,
        oldPlanTree: entry.plan,
        newPlan: next.planString,
        newCost: next.cost,
        newPlanTree: next.plan,
        oldHash,
        newHash,
        hashChanged: oldHash !== newHash,
      });
    }
    return { table, invalidated: affected.length, affected };
  }
}
