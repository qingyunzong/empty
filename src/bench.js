import { performance } from 'node:perf_hooks';
import { parseSql } from './parser.js';
import { buildLogicalPlan } from './plan.js';
import { optimize } from './optimizer.js';
import { enumeratePhysical, bestPlans } from './physical.js';
import { execLogical, execPhysical } from './exec.js';
import { hashResult } from './hash.js';

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function bench(rows) {
  const rand = mulberry32(42);
  const dimRows = [];
  for (let i = 1; i <= 50; i++) dimRows.push({ id: i, cat: `c${i % 10}` });
  const factRows = [];
  for (let i = 1; i <= rows; i++) {
    factRows.push({
      id: i,
      dim_id: rand() < 0.1 ? null : 1 + Math.floor(rand() * 50),
      val: rand() < 0.1 ? null : Math.floor(rand() * 1000),
    });
  }
  const tables = {
    fact: { columns: ['id', 'dim_id', 'val'], rows: factRows },
    dim: { columns: ['id', 'cat'], rows: dimRows },
  };
  const catalog = Object.fromEntries(Object.entries(tables).map(([k, v]) => [k, { columns: v.columns }]));
  const sql = 'SELECT d.cat, COUNT(f.id) AS n, SUM(f.val) AS total ' +
    'FROM fact f JOIN dim d ON f.dim_id = d.id GROUP BY d.cat HAVING COUNT(f.id) >= 1';
  const ast = parseSql(sql);
  const logical = buildLogicalPlan(ast, catalog);
  const { plan: optimized, rules } = optimize(logical);
  const alts = enumeratePhysical(optimized, { tables });
  const best = bestPlans(alts);
  const ctx = { tables };

  const t0 = performance.now();
  const direct = execLogical(logical, ctx);
  const directMs = performance.now() - t0;

  const t1 = performance.now();
  const opt = execPhysical(best[0].node, ctx);
  const optimizedMs = performance.now() - t1;

  const directHash = hashResult(direct);
  const optimizedHash = hashResult(opt);
  return {
    rows,
    tables: { fact: factRows.length, dim: dimRows.length },
    rules: rules.map((r) => r.rule),
    tiedBestPlans: best.length,
    chosenCost: best[0].cost,
    directMs: Number(directMs.toFixed(3)),
    optimizedMs: Number(optimizedMs.toFixed(3)),
    resultRows: opt.rows.length,
    unknownRows: opt.unknown.length,
    directHash,
    optimizedHash,
    equal: directHash === optimizedHash,
  };
}
