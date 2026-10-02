'use strict';

const fs = require('fs');
const path = require('path');
const { SyncError, ERR_READ_ONLY_TARGET } = require('./errors');
const { hashFile, scanDir, loadState, saveState } = require('./core');

function mapFsError(e, target) {
  if (e && (e.code === 'EACCES' || e.code === 'EPERM' || e.code === 'EROFS')) {
    return new SyncError(ERR_READ_ONLY_TARGET, `目标只读, 无法写入: ${target}`, { target });
  }
  return e;
}

function checkWritable(dir) {
  try {
    fs.accessSync(dir, fs.constants.W_OK | fs.constants.X_OK);
  } catch {
    throw new SyncError(ERR_READ_ONLY_TARGET, `目标目录只读或不可写: ${dir}`, { dir });
  }
}

function loadJournal(journalPath, planHash) {
  try {
    const j = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
    if (j && j.version === 1 && j.planHash === planHash && j.ops) return j;
  } catch {}
  return { version: 1, planHash, ops: {} };
}

function saveJournal(journalPath, journal) {
  fs.mkdirSync(path.dirname(journalPath), { recursive: true });
  const tmp = journalPath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(journal));
  fs.renameSync(tmp, journalPath);
}

// 分块复制: 每块写盘 + fsync + 记录日志后才算"已确认"; 崩溃恢复时从 confirmedBytes 续传
function copyChunked(op, journal, journalPath, ctx) {
  const tmp = `${op.dstPath}.part-${op.id.slice(0, 16)}`;
  let entry = journal.ops[op.id];
  if (!entry || entry.status === 'done') {
    entry = { status: 'in-progress', confirmedBytes: 0, chunksConfirmed: 0 };
  }
  if (fs.existsSync(tmp)) {
    const size = fs.statSync(tmp).size;
    if (size > entry.confirmedBytes) {
      fs.truncateSync(tmp, entry.confirmedBytes); // 最后一块可能写了一半, 截到已确认位置
    } else if (size < entry.confirmedBytes) {
      entry.confirmedBytes = size;
      entry.chunksConfirmed = Math.floor(size / ctx.chunkSize);
    }
  } else if (entry.confirmedBytes > 0) {
    entry.confirmedBytes = 0;
    entry.chunksConfirmed = 0;
  }
  const srcFd = fs.openSync(op.srcPath, 'r');
  const dstFd = fs.openSync(tmp, 'a');
  try {
    let offset = entry.confirmedBytes;
    const buf = Buffer.allocUnsafe(Math.min(ctx.chunkSize, Math.max(op.size - offset, 1)));
    while (offset < op.size) {
      const n = Math.min(ctx.chunkSize, op.size - offset);
      const chunk = n === buf.length ? buf : buf.subarray(0, n);
      fs.readSync(srcFd, chunk, 0, n, offset);
      fs.writeSync(dstFd, chunk, 0, n);
      fs.fsyncSync(dstFd);
      offset += n;
      entry.confirmedBytes = offset;
      entry.chunksConfirmed += 1;
      journal.ops[op.id] = entry;
      saveJournal(journalPath, journal); // 块确认落盘
      ctx.summary.bytesConfirmed += n;
      ctx.chunksConfirmedTotal += 1;
      if (process.env.SYNC_TRACE) {
        process.stderr.write(`CHUNK op=${op.id.slice(0, 12)} idx=${entry.chunksConfirmed - 1} confirmed=${offset}/${op.size}\n`);
      }
      if (ctx.killAfterChunks != null && ctx.chunksConfirmedTotal >= ctx.killAfterChunks) {
        process.exit(75); // 模拟被 kill: 立即退出, 不做任何清理
      }
    }
  } finally {
    fs.closeSync(srcFd);
    fs.closeSync(dstFd);
  }
  if (hashFile(tmp) !== op.hash) throw new SyncError(3, `复制校验失败: ${op.key}`);
  fs.renameSync(tmp, op.dstPath);
  try {
    const m = op.mtimeMs / 1000;
    fs.utimesSync(op.dstPath, m, m);
  } catch {}
  entry.status = 'done';
  journal.ops[op.id] = entry;
  saveJournal(journalPath, journal);
}

function writeMergedStates(plan) {
  const dirA = plan.dirs.a;
  const dirB = plan.dirs.b;
  const scanA = scanDir(dirA);
  const scanB = scanDir(dirB);
  const prevA = loadState(dirA);
  const prevB = loadState(dirB);
  const deletedOps = new Map();
  const conflictKeys = new Set();
  for (const op of plan.ops) {
    if (op.type === 'delete') deletedOps.set(op.key, op);
    if (op.type === 'conflict') conflictKeys.add(op.key);
  }
  const entries = {};
  const keys = new Set([...scanA.keys(), ...scanB.keys(), ...Object.keys(prevA.entries), ...Object.keys(prevB.entries)]);
  const now = Date.now();
  for (const key of keys) {
    if (conflictKeys.has(key)) {
      // 冲突未解决: 保留旧基准, 下次 diff 仍是冲突, 不会被静默覆盖
      const prev = prevA.entries[key] || prevB.entries[key];
      if (prev) entries[key] = prev;
      continue;
    }
    const a = scanA.get(key);
    const b = scanB.get(key);
    const cur = a || b;
    if (cur) {
      entries[key] = {
        hash: cur.hash, deleted: false, mtimeMs: cur.mtimeMs,
        vec: { a: a ? a.mtimeMs : null, b: b ? b.mtimeMs : null },
      };
    } else if (deletedOps.has(key)) {
      entries[key] = { deleted: true, hash: deletedOps.get(key).tombstoneHash, mtimeMs: now };
    } else {
      const prev = prevA.entries[key] || prevB.entries[key];
      if (prev) entries[key] = prev; // 保留既有墓碑
    }
  }
  const state = { version: 1, entries };
  saveState(dirA, state);
  saveState(dirB, state);
}

// 幂等执行: 已完成操作跳过; 目标内容已正确跳过; 中断的复制从已确认块续传
function applyPlan(plan, opts = {}) {
  const journalPath = opts.journalPath || path.join(process.cwd(), '.sync-journal.json');
  const chunkSize = opts.chunkSize || Number(process.env.SYNC_CHUNK_SIZE) || 1024 * 1024;
  const exec = plan.ops.filter((o) => o.type === 'copy' || o.type === 'delete');
  const conflicts = plan.ops.filter((o) => o.type === 'conflict');
  const summary = {
    copied: 0, deleted: 0, skipped: 0, bytesConfirmed: 0,
    conflicts: conflicts.length, conflictKeys: conflicts.map((c) => c.key),
  };
  if (exec.length === 0) return summary;

  const dirsToWrite = new Set([plan.dirs.a, plan.dirs.b]); // 两侧都要写 .sync/state.json
  for (const op of exec) dirsToWrite.add(op.type === 'copy' ? plan.dirs[op.to] : plan.dirs[op.dir]);
  for (const d of dirsToWrite) checkWritable(d);

  const journal = loadJournal(journalPath, plan.planHash);
  const killAfterChunks = opts.killAfterChunks != null
    ? opts.killAfterChunks
    : (process.env.SYNC_KILL_AFTER_CHUNKS ? Number(process.env.SYNC_KILL_AFTER_CHUNKS) : null);
  const ctx = { chunkSize, killAfterChunks, chunksConfirmedTotal: 0, summary };

  for (const op of exec) {
    const j = journal.ops[op.id];
    if (j && j.status === 'done') {
      summary.skipped += 1;
      continue;
    }
    if (op.type === 'delete') {
      try {
        fs.unlinkSync(op.path);
      } catch (e) {
        if (e.code !== 'ENOENT') throw mapFsError(e, op.path);
      }
      try { fs.unlinkSync(`${op.path}.part-${op.id.slice(0, 16)}`); } catch {}
      journal.ops[op.id] = { status: 'done' };
      saveJournal(journalPath, journal);
      summary.deleted += 1;
      continue;
    }
    // copy: 目标已是期望内容 → 幂等跳过
    if (fs.existsSync(op.dstPath)) {
      let same = false;
      try { same = hashFile(op.dstPath) === op.hash; } catch (e) { throw mapFsError(e, op.dstPath); }
      if (same) {
        journal.ops[op.id] = { status: 'done' };
        saveJournal(journalPath, journal);
        summary.skipped += 1;
        continue;
      }
    }
    try {
      copyChunked(op, journal, journalPath, ctx);
    } catch (e) {
      throw mapFsError(e, op.dstPath);
    }
    summary.copied += 1;
  }

  writeMergedStates(plan);
  return summary;
}

module.exports = { applyPlan, loadJournal, saveJournal };
