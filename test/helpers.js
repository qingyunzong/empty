import { parseSql } from '../src/parser.js';
import { buildLogicalPlan } from '../src/plan.js';
import { optimize } from '../src/optimizer.js';
import { enumeratePhysical, bestPlans } from '../src/physical.js';
import { execLogical, execPhysical } from '../src/exec.js';
import { buildCertificate } from '../src/cert.js';
import { hashResult } from '../src/hash.js';

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const catalogOf = (tables) =>
  Object.fromEntries(Object.entries(tables).map(([k, v]) => [k, { columns: v.columns }]));

export function runQuery(sql, tables) {
  const ast = parseSql(sql);
  const logical = buildLogicalPlan(ast, catalogOf(tables));
  const { plan: optimized, rules } = optimize(logical);
  const ctx = { tables };
  const alts = enumeratePhysical(optimized, ctx);
  const best = bestPlans(alts);
  const direct = execLogical(logical, ctx);
  const physicalResults = best.map((b) => execPhysical(b.node, ctx));
  const certificate = buildCertificate({ rules, tables, direct, optimized: physicalResults[0] });
  return { ast, logical, optimized, rules, alts, best, direct, physicalResults, certificate };
}

export function hashesOf(result) {
  return hashResult(result);
}

// random scientific-data-lake-ish tables with NULLs and duplicates
export function randomTables(seed, userCount, orderCount) {
  const rand = mulberry32(seed);
  const regions = ['eu', 'us', 'ap'];
  const statuses = ['paid', 'open', 'void'];
  const users = [];
  for (let i = 1; i <= userCount; i++) {
    users.push({
      id: i,
      name: `u${i % 7}`,
      age: rand() < 0.2 ? null : 10 + Math.floor(rand() * 70),
      region: rand() < 0.1 ? null : regions[Math.floor(rand() * regions.length)],
    });
  }
  const orders = [];
  for (let i = 1; i <= orderCount; i++) {
    orders.push({
      id: i,
      uid: rand() < 0.15 ? null : 1 + Math.floor(rand() * userCount),
      amount: rand() < 0.2 ? null : Math.floor(rand() * 500),
      status: statuses[Math.floor(rand() * statuses.length)],
    });
  }
  return {
    users: { columns: ['id', 'name', 'age', 'region'], rows: users },
    orders: { columns: ['id', 'uid', 'amount', 'status'], rows: orders },
  };
}
