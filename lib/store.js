'use strict';
// 组17 日终审计同步库：分块快照 + 增量流水 + 可信点恢复 + 覆盖证明。
// 仅使用 Node.js 22 标准库，单机离线。

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ERR_CHUNK = 50;    // 块缺失或损坏
const ERR_GAP = 51;      // seq 空洞
const ERR_CONFLICT = 52; // 同 seq 不同内容

class StoreError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'StoreError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

// 稳定序列化：键排序，保证同一逻辑内容哈希一致。
function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
}

function fsyncFile(file) {
  const fd = fs.openSync(file, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function fsyncDir(dir) {
  const fd = fs.openSync(dir, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function snapDirName(seq) {
  return 'seq-' + String(seq).padStart(8, '0');
}

function snapDir(dir, seq) {
  return path.join(dir, 'snapshots', snapDirName(seq));
}

function deltaLogPath(dir) {
  return path.join(dir, 'deltas.log');
}

// ---------------------------------------------------------------------------
// snapshot：分块写入 + manifest 原子提交（tmp -> fsync -> rename -> dir fsync）
// ---------------------------------------------------------------------------

function writeSnapshot(dir, balances, opts = {}) {
  const seq = opts.seq;
  const baseSeq = opts.baseSeq;
  if (!Number.isInteger(seq) || seq < 1) throw new StoreError(52, 'snapshot seq must be a positive integer');
  if (!Number.isInteger(baseSeq) || baseSeq < 0) throw new StoreError(52, 'baseSeq must be a non-negative integer');
  const chunkSize = opts.chunkSize || 100;
  const crashHook = opts.crashHook || null;

  const accounts = Object.keys(balances).sort();
  const sdir = snapDir(dir, seq);
  fs.rmSync(sdir, { recursive: true, force: true });
  fs.mkdirSync(sdir, { recursive: true });

  const chunks = [];
  const chunkCount = Math.max(1, Math.ceil(accounts.length / chunkSize));
  for (let i = 0; i < chunkCount; i++) {
    const slice = accounts.slice(i * chunkSize, (i + 1) * chunkSize);
    const body = { index: i, accounts: {} };
    for (const a of slice) body.accounts[a] = balances[a];
    const data = canonical(body);
    const file = 'chunk-' + String(i).padStart(4, '0') + '.json';
    const fp = path.join(sdir, file);
    fs.writeFileSync(fp, data);
    fsyncFile(fp);
    chunks.push({ file, sha256: sha256(data), accounts: slice.length });
  }
  fsyncDir(sdir);
  if (crashHook) crashHook('beforeManifestWrite');

  const manifest = {
    version: 1,
    seq,
    baseSeq,
    chunkSize,
    accountCount: accounts.length,
    chunks,
    createdAt: new Date().toISOString(),
  };
  const mdata = canonical(manifest);
  const tmp = path.join(sdir, 'manifest.json.tmp');
  fs.writeFileSync(tmp, mdata);
  fsyncFile(tmp);
  // 崩溃点：tmp 已 fsync 但未 rename —— manifest 未提交，本快照不可信。
  if (crashHook) crashHook('afterManifestFsync');
  fs.renameSync(tmp, path.join(sdir, 'manifest.json'));
  fsyncDir(sdir);
  // 崩溃点：manifest 已提交，本快照可信。
  if (crashHook) crashHook('afterCommit');

  return { manifest, manifestHash: sha256(mdata) };
}

function listSnapshotSeqs(dir) {
  const sdir = path.join(dir, 'snapshots');
  if (!fs.existsSync(sdir)) return [];
  return fs.readdirSync(sdir)
    .map((name) => {
      const m = /^seq-(\d+)$/.exec(name);
      return m ? parseInt(m[1], 10) : null;
    })
    .filter((v) => v !== null)
    .sort((a, b) => a - b);
}

function readManifest(dir, seq) {
  const mp = path.join(snapDir(dir, seq), 'manifest.json');
  if (!fs.existsSync(mp)) return null; // 未提交（可能只有 manifest.json.tmp）
  return JSON.parse(fs.readFileSync(mp, 'utf8'));
}

// 校验快照：manifest 已提交且所有块存在、哈希匹配。
function verifySnapshot(dir, seq) {
  const manifest = readManifest(dir, seq);
  if (!manifest) return { ok: false, reason: 'manifest-not-committed' };
  const balances = {};
  const chunkHashes = [];
  for (const chunk of manifest.chunks) {
    const fp = path.join(snapDir(dir, seq), chunk.file);
    if (!fs.existsSync(fp)) {
      return { ok: false, code: ERR_CHUNK, reason: 'chunk-missing', file: chunk.file, manifest };
    }
    const data = fs.readFileSync(fp, 'utf8');
    if (sha256(data) !== chunk.sha256) {
      return { ok: false, code: ERR_CHUNK, reason: 'chunk-corrupt', file: chunk.file, manifest };
    }
    chunkHashes.push(chunk.sha256);
    const body = JSON.parse(data);
    for (const [k, v] of Object.entries(body.accounts)) balances[k] = v;
  }
  return { ok: true, manifest, balances, chunkHashes };
}

// ---------------------------------------------------------------------------
// delta：追加式流水，支持 txn / correct(更正) / undo(撤销)，必须按位点接续
// ---------------------------------------------------------------------------

function validateDeltaEntry(entry) {
  if (!entry || typeof entry !== 'object') throw new StoreError(52, 'delta entry must be an object');
  if (!Number.isInteger(entry.seq) || entry.seq < 1) throw new StoreError(52, 'delta seq must be a positive integer');
  if (!['txn', 'correct', 'undo'].includes(entry.type)) {
    throw new StoreError(52, 'delta type must be txn|correct|undo');
  }
  if (entry.type === 'txn' || entry.type === 'correct') {
    if (!Array.isArray(entry.ops)) throw new StoreError(52, 'delta ops must be an array');
    for (const op of entry.ops) {
      if (typeof op.account !== 'string' || !Number.isFinite(op.delta)) {
        throw new StoreError(52, 'delta op must be {account:string, delta:number}');
      }
    }
  }
  if (entry.type === 'correct' || entry.type === 'undo') {
    if (!Number.isInteger(entry.target) || entry.target < 1 || entry.target >= entry.seq) {
      throw new StoreError(52, 'delta target must be an integer in [1, seq)');
    }
  }
}

function readDeltaLog(dir) {
  const lp = deltaLogPath(dir);
  const entries = [];
  if (!fs.existsSync(lp)) return entries;
  const seen = new Map();
  const lines = fs.readFileSync(lp, 'utf8').split('\n').filter((l) => l.length > 0);
  for (const line of lines) {
    const entry = JSON.parse(line);
    if (seen.has(entry.seq)) {
      if (canonical(seen.get(entry.seq)) !== canonical(entry)) {
        throw new StoreError(ERR_CONFLICT, 'conflicting delta entries at seq ' + entry.seq, { seq: entry.seq });
      }
      continue; // 同 seq 同内容：幂等
    }
    seen.set(entry.seq, entry);
    entries.push(entry);
  }
  entries.sort((a, b) => a.seq - b.seq);
  return entries;
}

function appendDelta(dir, entry) {
  validateDeltaEntry(entry);
  const lp = deltaLogPath(dir);
  let lastLine = null;
  if (fs.existsSync(lp)) {
    const data = fs.readFileSync(lp, 'utf8');
    if (data.length > 0) {
      const trimmed = data.endsWith('\n') ? data.slice(0, -1) : data;
      lastLine = trimmed.slice(trimmed.lastIndexOf('\n') + 1);
    }
  }
  const lastSeq = lastLine ? JSON.parse(lastLine).seq : 0;
  if (entry.seq < lastSeq) {
    // 罕见路径：与历史位点比较，全量扫描。
    const prev = readDeltaLog(dir).find((e) => e.seq === entry.seq);
    if (prev && canonical(prev) === canonical(entry)) return { appended: false, seq: entry.seq };
    throw new StoreError(ERR_CONFLICT, 'same seq with different content at seq ' + entry.seq, { seq: entry.seq });
  }
  if (entry.seq === lastSeq) {
    if (lastLine === canonical(entry)) return { appended: false, seq: entry.seq };
    throw new StoreError(ERR_CONFLICT, 'same seq with different content at seq ' + entry.seq, { seq: entry.seq });
  }
  if (entry.seq !== lastSeq + 1) {
    throw new StoreError(ERR_GAP, 'seq gap: expected ' + (lastSeq + 1) + ', got ' + entry.seq, {
      expected: lastSeq + 1, got: entry.seq,
    });
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(lp, canonical(entry) + '\n');
  fsyncFile(lp);
  return { appended: true, seq: entry.seq };
}

// 折叠流水：txn 记录 ops；correct 替换目标 ops；undo 置空目标。
function computeEffective(entries) {
  const eff = new Map(); // txnSeq -> ops | null
  for (const e of entries) {
    if (e.type === 'txn') eff.set(e.seq, e.ops);
    else if (e.type === 'correct') {
      if (!eff.has(e.target)) throw new StoreError(ERR_CONFLICT, 'correct targets unknown seq ' + e.target);
      eff.set(e.target, e.ops);
    } else if (e.type === 'undo') {
      if (!eff.has(e.target)) throw new StoreError(ERR_CONFLICT, 'undo targets unknown seq ' + e.target);
      eff.set(e.target, null);
    }
  }
  return eff;
}

function applyOps(balances, ops, sign) {
  for (const op of ops) {
    const next = (balances[op.account] || 0) + sign * op.delta;
    if (next === 0) delete balances[op.account];
    else balances[op.account] = next;
  }
}

// ---------------------------------------------------------------------------
// restore：最近可信快照（manifest 已提交且块完整）+ 其后的增量；
// 更高 commitSeq 的更正/撤销可回溯修正快照已覆盖的位点。
// ---------------------------------------------------------------------------

function restore(dir) {
  const warnings = [];
  const seqs = listSnapshotSeqs(dir).sort((a, b) => b - a);
  let trusted = null;
  for (const seq of seqs) {
    const v = verifySnapshot(dir, seq);
    if (v.ok) {
      trusted = { snapshotSeq: seq, baseSeq: v.manifest.baseSeq, balances: v.balances };
      break;
    }
    warnings.push({
      code: v.code || ERR_CHUNK,
      snapshotSeq: seq,
      reason: v.reason,
      file: v.file,
    });
  }
  if (!trusted) trusted = { snapshotSeq: 0, baseSeq: 0, balances: {} }; // 创世：空账簿

  const entries = readDeltaLog(dir);
  const baseSeq = trusted.baseSeq;

  // 位点接续检查：baseSeq 之后必须连续无空洞。
  const above = entries.filter((e) => e.seq > baseSeq).map((e) => e.seq);
  for (let i = 0; i < above.length; i++) {
    const expected = baseSeq + 1 + i;
    if (above[i] !== expected) {
      throw new StoreError(ERR_GAP, 'seq gap after baseSeq: expected ' + expected + ', got ' + above[i], {
        expected, got: above[i],
      });
    }
  }

  const effBase = computeEffective(entries.filter((e) => e.seq <= baseSeq));
  const effHead = computeEffective(entries);
  const balances = { ...trusted.balances };

  // 快照与增量冲突：以更高 commitSeq 为准 —— 快照之后出现的更正/撤销
  // 回溯修正已折入快照的位点（先撤旧效果，再套新效果）。
  for (const [t, ops] of effHead) {
    if (t > baseSeq) continue;
    const before = effBase.has(t) ? effBase.get(t) : null;
    const after = ops || null;
    if (canonical(before) !== canonical(after)) {
      if (before) applyOps(balances, before, -1);
      if (after) applyOps(balances, after, +1);
    }
  }
  // 应用 baseSeq 之后的有效增量。
  const tail = [...effHead.entries()].filter(([s]) => s > baseSeq).sort((a, b) => a[0] - b[0]);
  let applied = 0;
  for (const [, ops] of tail) {
    if (ops) { applyOps(balances, ops, +1); applied++; }
  }

  return {
    snapshotSeq: trusted.snapshotSeq,
    baseSeq,
    headSeq: entries.length ? entries[entries.length - 1].seq : 0,
    appliedDeltas: applied,
    warnings,
    balances,
  };
}

// ---------------------------------------------------------------------------
// check：覆盖证明；proof 可被 --verify 独立重算验证。
// ---------------------------------------------------------------------------

function deltaHeadHash(dir) {
  const lp = deltaLogPath(dir);
  let h = sha256('genesis');
  if (!fs.existsSync(lp)) return h;
  const lines = fs.readFileSync(lp, 'utf8').split('\n').filter((l) => l.length > 0);
  for (const line of lines) h = sha256(h + line);
  return h;
}

function check(dir) {
  const snapshots = [];
  let trusted = null;
  for (const seq of listSnapshotSeqs(dir).sort((a, b) => b - a)) {
    const committed = readManifest(dir, seq) !== null;
    const v = verifySnapshot(dir, seq);
    const entry = {
      seq,
      committed,
      ok: v.ok === true,
      reason: v.ok ? undefined : v.reason,
      file: v.file,
      manifestHash: committed ? sha256(canonical(v.manifest)) : undefined,
      chunkHashes: v.ok ? v.chunkHashes : undefined,
    };
    snapshots.push(entry);
    if (!trusted && v.ok) trusted = { snapshotSeq: seq, baseSeq: v.manifest.baseSeq };
  }
  snapshots.sort((a, b) => a.seq - b.seq);
  if (!trusted) trusted = { snapshotSeq: 0, baseSeq: 0 };

  const entries = readDeltaLog(dir);
  const seqs = entries.map((e) => e.seq);
  const seqSet = new Set(seqs);
  const gaps = [];
  for (let s = 1; s <= (seqs.length ? seqs[seqs.length - 1] : 0); s++) {
    if (!seqSet.has(s)) gaps.push(s);
  }
  const headSeq = seqs.length ? seqs[seqs.length - 1] : 0;
  const contiguous = gaps.length === 0;

  // 覆盖范围：可信快照覆盖到 baseSeq；之后增量连续覆盖到的最远位点。
  let coveredThrough = trusted.baseSeq;
  if (contiguous) coveredThrough = Math.max(coveredThrough, headSeq);
  else {
    for (let s = trusted.baseSeq + 1; s <= headSeq; s++) {
      if (gaps.includes(s)) break;
      coveredThrough = s;
    }
  }
  const complete = contiguous && coveredThrough === headSeq;

  const proof = {
    version: 1,
    snapshots,
    trusted,
    delta: {
      count: entries.length,
      firstSeq: seqs.length ? seqs[0] : 0,
      lastSeq: headSeq,
      contiguous,
      gaps,
      headHash: deltaHeadHash(dir),
    },
    coverage: { baseSeq: trusted.baseSeq, coveredThrough, headSeq, complete },
  };
  proof.proofHash = sha256(canonical(proof));
  proof.generatedAt = new Date().toISOString();
  return proof;
}

function verifyProof(dir, proof) {
  const recomputed = check(dir);
  const mismatches = [];
  const strip = (p) => {
    const c = { ...p };
    delete c.generatedAt;
    delete c.proofHash;
    return c;
  };
  if (canonical(strip(proof)) !== canonical(strip(recomputed))) {
    const a = strip(proof), b = strip(recomputed);
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (canonical(a[key]) !== canonical(b[key])) mismatches.push(key);
    }
  }
  const expectedHash = sha256(canonical(strip(proof)));
  if (proof.proofHash !== expectedHash) mismatches.push('proofHash');
  return { valid: mismatches.length === 0, mismatches };
}

module.exports = {
  ERR_CHUNK, ERR_GAP, ERR_CONFLICT,
  StoreError,
  sha256, canonical,
  writeSnapshot, readManifest, verifySnapshot, listSnapshotSeqs,
  appendDelta, readDeltaLog,
  restore, check, verifyProof,
};
