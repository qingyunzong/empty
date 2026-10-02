import fs from 'node:fs';
import path from 'node:path';
import { canonical, sha256 } from './event.js';
import { project } from './project.js';

export const GENESIS = 'GENESIS';

// 故障注入点（仅测试使用）：MAINT_SYNC_CRASH=before-append|after-append|before-rename|after-manifest
function crashPoint(name) {
  if (process.env.MAINT_SYNC_CRASH === name) process.exit(70);
}

export function storePaths(dir) {
  return {
    log: path.join(dir, 'events.log'),
    index: path.join(dir, 'index.json'),
    state: path.join(dir, 'state.json'),
    stateTmp: path.join(dir, 'state.json.tmp'),
    manifest: path.join(dir, 'audit-manifest.json'),
  };
}

function fsyncFile(p) {
  const fd = fs.openSync(p, 'r+');
  fs.fsyncSync(fd);
  fs.closeSync(fd);
}

export function writeJsonAtomic(p, obj) {
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fsyncFile(tmp);
  fs.renameSync(tmp, p);
}

export function readIndex(dir) {
  const p = storePaths(dir).index;
  if (!fs.existsSync(p)) return { ids: {}, count: 0, head: null, clock: {}, site: null };
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

export function readLog(dir) {
  const p = storePaths(dir).log;
  if (!fs.existsSync(p)) return [];
  const text = fs.readFileSync(p, 'utf8');
  return text
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((line, i) => ({ ...JSON.parse(line), line: i }));
}

export function verifyChain(records) {
  let prev = GENESIS;
  for (const rec of records) {
    const expect = sha256(prev + canonical(rec.event));
    if (rec.prev !== prev || rec.hash !== expect) return { ok: false, line: rec.line };
    prev = rec.hash;
  }
  return { ok: true, head: records.length ? records[records.length - 1].hash : null };
}

function writeSnapshotAndManifest(dir, idx, proj, crash) {
  const p = storePaths(dir);
  const snapshot = {
    lastSeq: idx.count,
    head: idx.head,
    clock: idx.clock,
    orders: proj.orders,
    decisions: Object.fromEntries([...proj.decisions].map(([k, v]) => [k, v.status])),
    pending: proj.pending,
    conflicts: proj.conflicts,
  };
  snapshot.hash = sha256(canonical(snapshot));
  fs.writeFileSync(p.stateTmp, JSON.stringify(snapshot, null, 2));
  fsyncFile(p.stateTmp);
  if (crash) crashPoint('before-rename');
  fs.renameSync(p.stateTmp, p.state);
  const manifest = { head: idx.head, count: idx.count, stateHash: snapshot.hash, clock: idx.clock };
  manifest.hash = sha256(canonical(manifest));
  writeJsonAtomic(p.manifest, manifest);
  if (crash) crashPoint('after-manifest');
  return snapshot;
}

export function ensureStore(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const p = storePaths(dir);
  if (!fs.existsSync(p.log)) fs.writeFileSync(p.log, '');
  if (!fs.existsSync(p.index)) writeJsonAtomic(p.index, { ids: {}, count: 0, head: null, clock: {}, site: null });
  if (!fs.existsSync(p.state)) {
    const idx = readIndex(dir);
    writeSnapshotAndManifest(dir, idx, project([]), false);
  }
}

export function appendEvent(dir, event, { crash = true } = {}) {
  ensureStore(dir);
  const p = storePaths(dir);
  const idx = readIndex(dir);
  if (idx.ids[event.id] !== undefined) return { duplicate: true };
  if (crash) crashPoint('before-append');
  const prev = idx.head ?? GENESIS;
  const hash = sha256(prev + canonical(event));
  fs.appendFileSync(p.log, JSON.stringify({ event, prev, hash }) + '\n');
  fsyncFile(p.log);
  if (crash) crashPoint('after-append');
  idx.ids[event.id] = idx.count;
  idx.count += 1;
  idx.head = hash;
  idx.clock[event.site] = Math.max(idx.clock[event.site] ?? 0, event.seq);
  writeJsonAtomic(p.index, idx);
  const proj = project(readLog(dir).map((r) => r.event));
  writeSnapshotAndManifest(dir, idx, proj, crash);
  return { duplicate: false, projection: proj };
}

// 检查点恢复：校验哈希链 -> 重建半索引 -> 以日志为准重算投影 -> 重写快照与清单。
// 重复事件按 id 去重，不会重复应用。
export function resume(dir) {
  ensureStore(dir);
  const p = storePaths(dir);
  const records = readLog(dir);
  const chain = verifyChain(records);
  if (!chain.ok) {
    const e = new Error(`log chain broken at line ${chain.line}`);
    e.code = 'CORRUPT';
    throw e;
  }
  const idx = readIndex(dir);
  const seen = new Set();
  const ids = {};
  const clock = {};
  let count = 0;
  let rebuilt = 0;
  for (const rec of records) {
    if (seen.has(rec.event.id)) continue;
    seen.add(rec.event.id);
    if (idx.ids[rec.event.id] === undefined) rebuilt += 1;
    ids[rec.event.id] = count;
    count += 1;
    clock[rec.event.site] = Math.max(clock[rec.event.site] ?? 0, rec.event.seq);
  }
  const newIndex = { ids, count, head: chain.head, clock, site: idx.site ?? null };
  writeJsonAtomic(p.index, newIndex);
  const proj = project(records.map((r) => r.event));
  writeSnapshotAndManifest(dir, newIndex, proj, false);
  return {
    events: count,
    rebuiltIndex: rebuilt,
    clock,
    pending: proj.pending,
    conflicts: proj.conflicts,
    orders: proj.orders,
  };
}

export function audit(dir) {
  const p = storePaths(dir);
  const checks = [];
  const records = readLog(dir);
  const chain = verifyChain(records);
  checks.push({ name: 'log-chain', ok: chain.ok });
  const idx = readIndex(dir);
  const indexOk =
    chain.ok &&
    idx.count === records.length &&
    Object.keys(idx.ids).length === records.length &&
    records.every((r) => idx.ids[r.event.id] !== undefined) &&
    idx.head === chain.head;
  checks.push({ name: 'index', ok: indexOk });
  let stateOk = false;
  let stateHash = null;
  if (fs.existsSync(p.state)) {
    const snap = JSON.parse(fs.readFileSync(p.state, 'utf8'));
    const { hash, ...body } = snap;
    stateHash = hash ?? null;
    const proj = project(records.map((r) => r.event));
    stateOk =
      hash === sha256(canonical(body)) &&
      canonical(snap.orders) === canonical(proj.orders) &&
      snap.head === chain.head;
  }
  checks.push({ name: 'snapshot', ok: stateOk });
  let manifestOk = false;
  if (fs.existsSync(p.manifest)) {
    const m = JSON.parse(fs.readFileSync(p.manifest, 'utf8'));
    const { hash, ...body } = m;
    manifestOk =
      hash === sha256(canonical(body)) &&
      m.head === chain.head &&
      m.count === records.length &&
      m.stateHash === stateHash;
  }
  checks.push({ name: 'manifest', ok: manifestOk });
  return { ok: checks.every((c) => c.ok), checks, head: chain.head ?? null, count: records.length };
}
