import fs from 'node:fs';
import path from 'node:path';
import { loadCatalog, saveCatalog } from './catalog.js';
import { executePlan } from './executor.js';
import { optimize } from './optimizer.js';
import { deepMerge, hashRows, sha256, stableStringify } from './util.js';

function cachePath(dbDir) {
  return path.join(dbDir, 'plans.json');
}

function loadCache(dbDir) {
  const file = cachePath(dbDir);
  if (!fs.existsSync(file)) return { entries: {} };
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function saveCache(dbDir, cache) {
  fs.writeFileSync(cachePath(dbDir), JSON.stringify(cache, null, 2) + '\n');
}

export function queryHash(query) {
  return sha256(stableStringify(query));
}

function runPlan(dbDir, catalog, plan) {
  const rows = executePlan(plan, { dbDir, catalog });
  return { rows, hash: hashRows(rows) };
}

export function explain(dbDir, rawQuery) {
  const catalog = loadCatalog(dbDir);
  const { best, candidateCount } = optimize(catalog, rawQuery);
  const cache = loadCache(dbDir);
  const hash = queryHash(rawQuery);
  const existing = cache.entries[hash];
  cache.entries[hash] = {
    query: rawQuery,
    tables: tableList(best.plan),
    plan: best.plan,
    planString: best.planString,
    cost: best.cost,
    resultHash: existing?.resultHash ?? null,
  };
  saveCache(dbDir, cache);
  return {
    plan: best.plan,
    planString: best.planString,
    cost: best.cost,
    estimatedRows: best.rows,
    candidates: candidateCount,
  };
}

export function execute(dbDir, rawQuery) {
  const catalog = loadCatalog(dbDir);
  const { best, candidateCount } = optimize(catalog, rawQuery);
  const { rows, hash } = runPlan(dbDir, catalog, best.plan);
  const cache = loadCache(dbDir);
  cache.entries[queryHash(rawQuery)] = {
    query: rawQuery,
    tables: tableList(best.plan),
    plan: best.plan,
    planString: best.planString,
    cost: best.cost,
    resultHash: hash,
  };
  saveCache(dbDir, cache);
  return {
    rows,
    rowCount: rows.length,
    hash,
    planString: best.planString,
    cost: best.cost,
    candidates: candidateCount,
  };
}

function tableList(plan) {
  const tables = new Set();
  (function walk(node) {
    if (node.op === 'scan' || node.op === 'idxscan') tables.add(node.table);
    if (node.input) walk(node.input);
    if (node.left) walk(node.left);
    if (node.right) walk(node.right);
  })(plan);
  return [...tables].sort();
}

export function updateStats(dbDir, table, patch) {
  const catalog = loadCatalog(dbDir);
  if (!catalog.tables?.[table]) throw new Error(`unknown table: ${table}`);
  deepMerge(catalog.tables[table], patch);
  saveCatalog(dbDir, catalog);

  const cache = loadCache(dbDir);
  const invalidated = [];
  let unaffected = 0;
  for (const [hash, entry] of Object.entries(cache.entries)) {
    if (!entry.tables.includes(table)) {
      unaffected++;
      continue;
    }
    // only plans referencing the updated table are invalidated
    const oldHash = entry.resultHash ?? runPlan(dbDir, catalog, entry.plan).hash;
    const { best } = optimize(catalog, entry.query);
    const { hash: newHash } = runPlan(dbDir, catalog, best.plan);
    invalidated.push({
      queryHash: hash,
      tables: entry.tables,
      oldPlan: entry.planString,
      oldCost: entry.cost,
      newPlan: best.planString,
      newCost: best.cost,
      planChanged: entry.planString !== best.planString,
      oldHash,
      newHash,
      hashChanged: oldHash !== newHash,
    });
    cache.entries[hash] = {
      ...entry,
      plan: best.plan,
      planString: best.planString,
      cost: best.cost,
      resultHash: newHash,
    };
  }
  saveCache(dbDir, cache);
  return { table, applied: patch, invalidated, unaffected };
}
