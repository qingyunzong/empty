"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { SnapError } = require("./errors");
const { stableStringify, sha256 } = require("./canon");
const { writeJsonAtomic, readJsonFile } = require("./fsutil");
const {
  snapDir,
  snapshotPath,
  paramsPath,
  readParams,
  paramsHash,
  loadSnapshot,
  normalizeTable,
} = require("./snapshot");
const { loadSchema } = require("./schema");
const { diffParams, diffTable, tableNames, summarizeStatus } = require("./diff");

function journalPath(runDir) {
  return path.join(snapDir(runDir), "journal.jsonl");
}
function indexPath(runDir) {
  return path.join(snapDir(runDir), "index.json");
}
function diffCachePath(runDir) {
  return path.join(snapDir(runDir), "diffcache.json");
}

function readJournal(runDir) {
  const file = journalPath(runDir);
  if (!fs.existsSync(file)) return [];
  const entries = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch (err) {
      throw new SnapError("E_SNAP", `corrupt journal in ${runDir}: ${err.message}`);
    }
  }
  return entries;
}

function appendJournal(runDir, entry) {
  fs.mkdirSync(snapDir(runDir), { recursive: true });
  const fd = fs.openSync(journalPath(runDir), "a");
  try {
    fs.writeSync(fd, JSON.stringify(entry) + "\n");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function pendingPatches(entries) {
  const committed = new Set(entries.filter((e) => e.op === "commit").map((e) => e.seq));
  return entries.filter((e) => e.op === "patch" && !committed.has(e.seq));
}

function lastCommittedSeq(entries) {
  return entries.filter((e) => e.op === "commit").reduce((m, e) => Math.max(m, e.seq || 0), 0);
}

function loadIndex(runDir) {
  const file = indexPath(runDir);
  if (!fs.existsSync(file)) return null;
  try {
    return readJsonFile(file);
  } catch (err) {
    throw new SnapError("E_SNAP", `corrupt index in ${runDir}: ${err.message}`);
  }
}

function writeIndex(runDir, snap, journalSeq) {
  const tables = {};
  for (const [name, t] of Object.entries(snap.tables)) {
    tables[name] = { hash: t.hash, dataHash: t.dataHash || null };
  }
  writeJsonAtomic(indexPath(runDir), {
    version: 1,
    paramsHash: snap.paramsHash,
    tables,
    journalSeq,
    updatedAt: new Date().toISOString(),
  });
}

function getPath(obj, dotted) {
  const parts = dotted.split(".");
  let cur = obj;
  for (const p of parts) {
    if (typeof cur !== "object" || cur === null || !Object.prototype.hasOwnProperty.call(cur, p)) return undefined;
    cur = cur[p];
  }
  return cur;
}

function setPath(obj, dotted, value) {
  const parts = dotted.split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (typeof cur[parts[i]] !== "object" || cur[parts[i]] === null) cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
}

function deletePath(obj, dotted) {
  const parts = dotted.split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (typeof cur[parts[i]] !== "object" || cur[parts[i]] === null) return;
    cur = cur[parts[i]];
  }
  if (typeof cur === "object" && cur !== null) delete cur[parts[parts.length - 1]];
}

// change.json: { "set": { "a.b": v }, "unset": ["a.b"], "undo": ["a.b"] }
// "undo" restores the value a param had before the most recent journaled
// patch that touched it.
function applyChangeToParams(params, change, journal) {
  if (!change || typeof change !== "object" || Array.isArray(change)) {
    throw new SnapError("E_SNAP", "change.json must be a JSON object");
  }
  const after = JSON.parse(JSON.stringify(params));
  const touched = [];
  for (const [p, v] of Object.entries(change.set || {})) {
    setPath(after, p, v);
    touched.push(p);
  }
  for (const p of change.unset || []) {
    deletePath(after, p);
    touched.push(p);
  }
  for (const p of change.undo || []) {
    const prior = journal
      .filter((e) => e.op === "patch" && Array.isArray(e.touched) && e.touched.includes(p))
      .pop();
    if (!prior) {
      throw new SnapError("E_SNAP", `no journal history for param "${p}"; cannot undo`);
    }
    const value = getPath(prior.paramsBefore, p);
    if (value === undefined) deletePath(after, p);
    else setPath(after, p, value);
    touched.push(p);
  }
  if (touched.length === 0) {
    throw new SnapError("E_SNAP", "change.json has no effect: use set, unset and/or undo");
  }
  return { paramsAfter: after, touched: [...new Set(touched)].sort() };
}

function affectedTablesForPaths(deps, paths, allTables) {
  const out = new Set();
  for (const p of paths) {
    let matched = false;
    for (const [depKey, tables] of Object.entries(deps || {})) {
      if (p === depKey || p.startsWith(depKey + ".")) {
        matched = true;
        for (const t of tables) out.add(t);
      }
    }
    if (!matched) for (const t of allTables) out.add(t); // conservative
  }
  return [...out].sort();
}

function rebuildTables(runDir, snap, tableNamesToBuild, params) {
  const next = JSON.parse(JSON.stringify(snap));
  next.params = params;
  next.paramsHash = paramsHash(params);
  next.schema = loadSchema(runDir);
  for (const name of tableNamesToBuild) {
    const csvPath = path.join(runDir, "data", name + ".csv");
    if (!fs.existsSync(csvPath)) {
      delete next.tables[name];
      continue;
    }
    const content = fs.readFileSync(csvPath, "utf8");
    const table = normalizeTable(name, content, next.schema.tables[name] || {});
    table.dataHash = sha256(content);
    next.tables[name] = table;
  }
  return next;
}

// Tables whose on-disk CSV no longer matches the snapshot.
function staleTables(runDir, snap) {
  const stale = [];
  const dataDir = path.join(runDir, "data");
  const onDisk = new Set(
    fs.existsSync(dataDir) ? fs.readdirSync(dataDir).filter((f) => f.endsWith(".csv")).map((f) => f.slice(0, -4)) : []
  );
  for (const name of Object.keys(snap.tables)) {
    if (!onDisk.has(name)) {
      stale.push(name);
      continue;
    }
    const content = fs.readFileSync(path.join(dataDir, name + ".csv"), "utf8");
    if (snap.tables[name].dataHash !== sha256(content)) stale.push(name);
  }
  for (const name of onDisk) {
    if (!snap.tables[name]) stale.push(name);
  }
  return [...new Set(stale)].sort();
}

// Everything that must hold for a snapshot to be trustworthy.
function consistencyProblems(runDir, snap) {
  const problems = [];
  const index = loadIndex(runDir);
  if (!index) problems.push("missing .snap/index.json");
  else {
    if (index.paramsHash !== snap.paramsHash) problems.push("index paramsHash is stale");
    for (const [name, t] of Object.entries(snap.tables)) {
      if (!index.tables || index.tables[name]?.hash !== t.hash) problems.push(`index entry for table "${name}" is stale`);
    }
  }
  if (paramsHash(readParams(runDir)) !== snap.paramsHash) problems.push("params.json differs from snapshot");
  for (const name of staleTables(runDir, snap)) problems.push(`table "${name}" data differs from snapshot`);
  const pending = pendingPatches(readJournal(runDir));
  if (pending.length) problems.push(`uncommitted journal entries: ${pending.map((e) => e.seq).join(", ")}`);
  return problems;
}

function assertConsistent(runDir, snap) {
  const problems = consistencyProblems(runDir, snap);
  if (problems.length) {
    throw new SnapError("E_SNAP", `run ${runDir} is inconsistent; run 'snapdiff recheck ${runDir}'`, problems);
  }
}

// patch: journal-first, then params, then snapshot, then index, then commit.
// A crash anywhere before the index update leaves a pending journal entry
// that `recheck` replays idempotently.
function patchRun(runDir, change, opts = {}) {
  const snap = loadSnapshot(runDir);
  const journal = readJournal(runDir);
  const pending = pendingPatches(journal);
  if (pending.length) {
    throw new SnapError(
      "E_SNAP",
      `uncommitted journal entries (${pending.map((e) => e.seq).join(", ")}); run 'snapdiff recheck ${runDir}'`
    );
  }
  const paramsBefore = readParams(runDir);
  if (snap.paramsHash !== paramsHash(paramsBefore)) {
    throw new SnapError("E_SNAP", "params.json changed since snapshot; run 'snapdiff recheck' first");
  }
  const { paramsAfter, touched } = applyChangeToParams(paramsBefore, change, journal);
  const seq = journal.reduce((m, e) => Math.max(m, e.seq || 0), 0) + 1;
  const affected = affectedTablesForPaths(snap.schema?.deps, touched, Object.keys(snap.tables));
  appendJournal(runDir, {
    seq,
    op: "patch",
    change,
    touched,
    affectedTables: affected,
    paramsBefore,
    paramsAfter,
    at: new Date().toISOString(),
  });
  writeJsonAtomic(paramsPath(runDir), paramsAfter);
  const next = rebuildTables(runDir, snap, affected, paramsAfter);
  writeJsonAtomic(snapshotPath(runDir), next);
  if (opts.crashBeforeIndex) opts.crashBeforeIndex();
  writeIndex(runDir, next, seq);
  appendJournal(runDir, { seq, op: "commit", at: new Date().toISOString() });
  return { seq, touched, affectedTables: affected, paramsHash: next.paramsHash };
}

// recheck: replay pending journal entries (idempotent), repair drift between
// files and snapshot, then verify consistency.
function recheck(runDir) {
  const journal = readJournal(runDir);
  const replayed = [];
  for (const entry of pendingPatches(journal)) {
    let current = null;
    try {
      current = readParams(runDir);
    } catch {
      current = null;
    }
    if (current === null || stableStringify(current) !== stableStringify(entry.paramsAfter)) {
      writeJsonAtomic(paramsPath(runDir), entry.paramsAfter);
    }
    const snap = loadSnapshot(runDir);
    const next = rebuildTables(runDir, snap, entry.affectedTables, entry.paramsAfter);
    writeJsonAtomic(snapshotPath(runDir), next);
    writeIndex(runDir, next, entry.seq);
    appendJournal(runDir, { seq: entry.seq, op: "commit", at: new Date().toISOString() });
    replayed.push(entry.seq);
  }
  const rebuilt = [];
  let snap = loadSnapshot(runDir);
  const params = readParams(runDir);
  const stale = staleTables(runDir, snap);
  if (stale.length || snap.paramsHash !== paramsHash(params)) {
    snap = rebuildTables(runDir, snap, stale, params);
    writeJsonAtomic(snapshotPath(runDir), snap);
    rebuilt.push(...stale);
  }
  writeIndex(runDir, snap, lastCommittedSeq(readJournal(runDir)));
  assertConsistent(runDir, snap);
  return { replayed, rebuilt, consistent: true };
}

// recheck a b: repair both runs, then recompute the pairwise diff
// incrementally -- tables whose hashes are unchanged since the last cached
// diff are reused, only affected tables are recomputed.
function recheckPair(aDir, bDir) {
  const ra = recheck(aDir);
  const rb = recheck(bDir);
  const snapA = loadSnapshot(aDir);
  const snapB = loadSnapshot(bDir);
  let cache = null;
  try {
    cache = readJsonFile(diffCachePath(aDir));
  } catch {
    cache = null;
  }
  const tolHash = sha256(
    stableStringify([
      Object.fromEntries(
        Object.entries(snapA.tables).map(([n, t]) => [n, t.tolerance || {}])
      ),
      Object.fromEntries(
        Object.entries(snapB.tables).map(([n, t]) => [n, t.tolerance || {}])
      ),
    ])
  );
  const tables = {};
  const reused = [];
  const recomputed = [];
  const newCache = { version: 1, tolHash, tables: {} };
  for (const name of tableNames(snapA, snapB)) {
    const aHash = snapA.tables[name]?.hash || null;
    const bHash = snapB.tables[name]?.hash || null;
    const cached = cache && cache.tolHash === tolHash ? cache.tables?.[name] : null;
    if (cached && cached.aHash === aHash && cached.bHash === bHash) {
      tables[name] = cached.result;
      reused.push(name);
    } else {
      tables[name] = diffTable(snapA, snapB, name);
      recomputed.push(name);
    }
    newCache.tables[name] = { aHash, bHash, result: tables[name] };
  }
  const paramChanges = diffParams(snapA.params, snapB.params);
  writeJsonAtomic(diffCachePath(aDir), newCache);
  return {
    replayed: { a: ra.replayed, b: rb.replayed },
    rebuilt: { a: ra.rebuilt, b: rb.rebuilt },
    reused,
    recomputed,
    diff: {
      status: summarizeStatus(paramChanges.length, tables),
      params: { changed: paramChanges },
      tables,
    },
  };
}

module.exports = {
  journalPath,
  indexPath,
  diffCachePath,
  readJournal,
  appendJournal,
  pendingPatches,
  lastCommittedSeq,
  loadIndex,
  writeIndex,
  applyChangeToParams,
  affectedTablesForPaths,
  rebuildTables,
  staleTables,
  consistencyProblems,
  assertConsistent,
  patchRun,
  recheck,
  recheckPair,
};
