'use strict';

const fs = require('fs');
const path = require('path');
const { sha256, stableStringify, keyFromFileName, fileNameForKey } = require('./util');
const { SyncError, ERR_TOMBSTONE_RESURRECTION } = require('./errors');

function hashFile(p) {
  return sha256(fs.readFileSync(p));
}

// 扫描目录: 返回 Map<key, {key, fileName, path, hash, mtimeMs, size}>
function scanDir(dir) {
  const out = new Map();
  for (const name of fs.readdirSync(dir)) {
    const key = keyFromFileName(name);
    if (!key) continue;
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (!st.isFile()) continue;
    out.set(key, { key, fileName: name, path: p, hash: hashFile(p), mtimeMs: st.mtimeMs, size: st.size });
  }
  return out;
}

function statePath(dir) {
  return path.join(dir, '.sync', 'state.json');
}

function loadState(dir) {
  try {
    const s = JSON.parse(fs.readFileSync(statePath(dir), 'utf8'));
    if (s && s.version === 1 && s.entries && typeof s.entries === 'object') return s;
  } catch {}
  return { version: 1, entries: {} };
}

function saveState(dir, state) {
  fs.mkdirSync(path.dirname(statePath(dir)), { recursive: true });
  const tmp = statePath(dir) + '.tmp';
  fs.writeFileSync(tmp, stableStringify(state) + '\n');
  fs.renameSync(tmp, statePath(dir));
}

// 冲突证书: 内容定址, 与目录参数顺序无关 (同一冲突在 A→B / B→A 下 certId 相同)
function makeCertificate({ key, kind, sides, baseHash }) {
  const canonSides = sides
    .map((s) => ({ hash: s.hash || null, mtimeMs: s.mtimeMs == null ? null : s.mtimeMs, present: !!s.present }))
    .sort((x, y) => String(x.hash).localeCompare(String(y.hash)));
  const contentHashes = canonSides.filter((s) => s.hash).map((s) => s.hash).sort();
  const body = { type: 'conflict-certificate', version: 1, key, kind, baseHash: baseHash || null, contentHashes, sides: canonSides };
  const certId = sha256(stableStringify(body));
  const explanation = explainConflict({ key, kind, sides: canonSides, baseHash });
  return { ...body, explanation, certId };
}

function explainConflict({ key, kind, sides, baseHash }) {
  const fmt = (s) =>
    s.present ? `hash=${String(s.hash).slice(0, 12)}… mtimeMs=${s.mtimeMs}` : '缺失(已删除)';
  if (kind === 'both-modified') {
    return baseHash
      ? `键 ${key}: 两端在上次同步(基准 hash=${String(baseHash).slice(0, 12)}…)之后各自做了不同修改; ` +
        `侧1 ${fmt(sides[0])}; 侧2 ${fmt(sides[1])}; 内容哈希不同, 禁止任一侧按目录顺序静默胜出`
      : `键 ${key}: 无同步基准记录, 两端初始内容即不同; 侧1 ${fmt(sides[0])}; 侧2 ${fmt(sides[1])}`;
  }
  if (kind === 'delete-update') {
    const kept = sides.find((s) => s.present);
    return `键 ${key}: 一端已删除(基准 hash=${String(baseHash).slice(0, 12)}…), 另一端在基准之后做了修改; 保留侧 ${fmt(kept)}`;
  }
  return `键 ${key}: 内容分叉且无法归因到同步基准`;
}

// 纯函数: 由两份扫描结果与两份同步状态计算每个键的动作
function computeActions(scanA, scanB, stateA, stateB) {
  const actions = [];
  const errors = [];
  const keys = new Set([...scanA.keys(), ...scanB.keys(), ...Object.keys(stateA.entries), ...Object.keys(stateB.entries)]);
  for (const key of [...keys].sort()) {
    const a = scanA.get(key) || null;
    const b = scanB.get(key) || null;
    const sa = stateA.entries[key] || null;
    const sb = stateB.entries[key] || null;

    // 墓碑复活检查: 本侧已有墓碑, 文件却以被删时的相同内容重现(无新版本) → code 61
    let resurrected = false;
    for (const [side, cur, st] of [['a', a, sa], ['b', b, sb]]) {
      if (cur && st && st.deleted && st.hash != null && cur.hash === st.hash) {
        errors.push({
          code: ERR_TOMBSTONE_RESURRECTION,
          key,
          side,
          message: `墓碑复活且无新版本: 键 ${key} 在 ${side.toUpperCase()} 侧以被删除时的相同内容重现 (hash=${cur.hash.slice(0, 12)}…)`,
        });
        resurrected = true;
      }
    }
    if (resurrected) continue;

    const base = (sa && !sa.deleted) ? sa : (sb && !sb.deleted) ? sb : null;
    const tomb = (sa && sa.deleted) ? sa : (sb && sb.deleted) ? sb : null;

    if (a && b) {
      if (a.hash === b.hash) {
        actions.push({ type: 'noop', key, hash: a.hash });
        continue;
      }
      const changedA = !base || a.hash !== base.hash;
      const changedB = !base || b.hash !== base.hash;
      if (changedA && changedB) {
        actions.push({
          type: 'conflict', key, kind: 'both-modified',
          certificate: makeCertificate({
            key, kind: 'both-modified',
            sides: [
              { hash: a.hash, mtimeMs: a.mtimeMs, present: true },
              { hash: b.hash, mtimeMs: b.mtimeMs, present: true },
            ],
            baseHash: base ? base.hash : null,
          }),
        });
      } else if (changedA) {
        actions.push({
          type: 'copy', key, from: 'a', hash: a.hash, size: a.size, mtimeMs: a.mtimeMs,
          reason: base ? `仅 A 端在基准(hash=${base.hash.slice(0, 12)}…)之后修改` : '仅 A 端内容偏离基准',
        });
      } else if (changedB) {
        actions.push({
          type: 'copy', key, from: 'b', hash: b.hash, size: b.size, mtimeMs: b.mtimeMs,
          reason: base ? `仅 B 端在基准(hash=${base.hash.slice(0, 12)}…)之后修改` : '仅 B 端内容偏离基准',
        });
      } else {
        actions.push({
          type: 'conflict', key, kind: 'diverged-unknown',
          certificate: makeCertificate({
            key, kind: 'diverged-unknown',
            sides: [
              { hash: a.hash, mtimeMs: a.mtimeMs, present: true },
              { hash: b.hash, mtimeMs: b.mtimeMs, present: true },
            ],
            baseHash: base ? base.hash : null,
          }),
        });
      }
      continue;
    }

    if (a || b) {
      const cur = a || b;
      const side = a ? 'a' : 'b';
      const other = a ? 'b' : 'a';
      const otherState = a ? sb : sa;
      if (otherState && otherState.deleted && (otherState.hash == null || otherState.hash === cur.hash)) {
        actions.push({
          type: 'delete', key, dir: side, tombstoneHash: cur.hash,
          reason: `${other.toUpperCase()} 侧已删除(墓碑), 传播删除到 ${side.toUpperCase()} 侧`,
        });
      } else if (base && base.hash === cur.hash) {
        actions.push({
          type: 'delete', key, dir: side, tombstoneHash: cur.hash,
          reason: `${other.toUpperCase()} 侧删除了该键(基准 hash=${base.hash.slice(0, 12)}… 未变), 传播删除`,
        });
      } else if (base) {
        actions.push({
          type: 'conflict', key, kind: 'delete-update',
          certificate: makeCertificate({
            key, kind: 'delete-update',
            sides: [
              { hash: a ? a.hash : null, mtimeMs: a ? a.mtimeMs : null, present: !!a },
              { hash: b ? b.hash : null, mtimeMs: b ? b.mtimeMs : null, present: !!b },
            ],
            baseHash: base.hash,
          }),
        });
      } else {
        actions.push({
          type: 'copy', key, from: side, hash: cur.hash, size: cur.size, mtimeMs: cur.mtimeMs,
          reason: `仅 ${side.toUpperCase()} 端存在该键(新增)`,
        });
      }
      continue;
    }

    actions.push({ type: 'noop', key, deleted: true, tombstone: !!tomb });
  }
  return { actions, errors };
}

function opId(obj) {
  return sha256(stableStringify(obj));
}

// 纯函数: 由扫描/状态数据生成最小同步计划 (每个需要动作的键恰好一个操作)
function planFromData({ dirs, scanA, scanB, stateA, stateB }) {
  const { actions, errors } = computeActions(scanA, scanB, stateA, stateB);
  const err61 = errors.find((e) => e.code === ERR_TOMBSTONE_RESURRECTION);
  if (err61) throw new SyncError(ERR_TOMBSTONE_RESURRECTION, err61.message, { key: err61.key });
  const ops = [];
  for (const act of actions) {
    if (act.type === 'noop') continue;
    if (act.type === 'copy') {
      const to = act.from === 'a' ? 'b' : 'a';
      const fileName = fileNameForKey(act.key);
      ops.push({
        id: opId({ type: 'copy', key: act.key, hash: act.hash, from: act.from, to }),
        type: 'copy', key: act.key, from: act.from, to,
        hash: act.hash, size: act.size, mtimeMs: act.mtimeMs,
        srcPath: path.join(dirs[act.from], fileName),
        dstPath: path.join(dirs[to], fileName),
        reason: act.reason,
      });
    } else if (act.type === 'delete') {
      ops.push({
        id: opId({ type: 'delete', key: act.key, dir: act.dir, tombstoneHash: act.tombstoneHash }),
        type: 'delete', key: act.key, dir: act.dir,
        path: path.join(dirs[act.dir], fileNameForKey(act.key)),
        tombstoneHash: act.tombstoneHash,
        reason: act.reason,
      });
    } else if (act.type === 'conflict') {
      ops.push({
        id: opId({ type: 'conflict', key: act.key, certId: act.certificate.certId }),
        type: 'conflict', key: act.key, kind: act.kind,
        certificate: act.certificate,
      });
    }
  }
  const plan = { version: 1, dirs, ops };
  plan.planHash = sha256(stableStringify({ v: 1, ops: ops.map((o) => o.id) }));
  plan.stats = {
    copies: ops.filter((o) => o.type === 'copy').length,
    deletes: ops.filter((o) => o.type === 'delete').length,
    conflicts: ops.filter((o) => o.type === 'conflict').length,
  };
  return plan;
}

function buildPlan(dirA, dirB) {
  return planFromData({
    dirs: { a: dirA, b: dirB },
    scanA: scanDir(dirA),
    scanB: scanDir(dirB),
    stateA: loadState(dirA),
    stateB: loadState(dirB),
  });
}

function diffDirs(dirA, dirB) {
  const scanA = scanDir(dirA);
  const scanB = scanDir(dirB);
  const stateA = loadState(dirA);
  const stateB = loadState(dirB);
  const { actions, errors } = computeActions(scanA, scanB, stateA, stateB);
  return {
    dirA, dirB,
    changes: actions.filter((x) => x.type !== 'noop'),
    unchanged: actions.filter((x) => x.type === 'noop').length,
    errors,
  };
}

module.exports = {
  hashFile, scanDir, loadState, saveState, statePath,
  makeCertificate, computeActions, planFromData, buildPlan, diffDirs,
};
