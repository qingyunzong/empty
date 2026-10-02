'use strict';

const fs = require('fs');
const path = require('path');
const { buildPlan, scanDir, loadState, saveState } = require('./core');
const { fileNameForKey, stableStringify } = require('./util');
const { SyncError, ERR_READ_ONLY_TARGET } = require('./errors');

function writeIfChanged(p, content) {
  if (fs.existsSync(p)) {
    const cur = fs.readFileSync(p);
    if (cur.equals(content)) return false;
  }
  fs.writeFileSync(p, content);
  return true;
}

// 处理冲突: 默认 keep-both (双份内容都保留, 原键墓碑化);
// strategy=a|b 时指定侧胜出, 败方内容仍以哈希副本保留在两侧
function resolveConflicts(dirA, dirB, opts = {}) {
  const strategy = opts.strategy || 'keep-both';
  if (!['keep-both', 'a', 'b'].includes(strategy)) {
    throw new SyncError(2, `未知策略: ${strategy} (可选 keep-both|a|b)`);
  }
  const plan = buildPlan(dirA, dirB); // 墓碑复活会在此抛 code 61
  const conflicts = plan.ops.filter((o) => o.type === 'conflict');
  if (conflicts.length === 0) return { resolved: 0, certificates: [] };

  for (const d of [dirA, dirB]) {
    try {
      fs.accessSync(d, fs.constants.W_OK | fs.constants.X_OK);
    } catch {
      throw new SyncError(ERR_READ_ONLY_TARGET, `目标目录只读或不可写: ${d}`, { dir: d });
    }
  }

  const scanA = scanDir(dirA);
  const scanB = scanDir(dirB);
  const stateA = loadState(dirA);
  const stateB = loadState(dirB);
  const certificates = [];

  for (const c of conflicts) {
    const cert = c.certificate;
    const fileName = fileNameForKey(c.key);
    const base = fileName.replace(/\.csv$/, '');
    const aE = scanA.get(c.key);
    const bE = scanB.get(c.key);

    const versions = new Map();
    if (aE) versions.set(aE.hash, fs.readFileSync(aE.path));
    if (bE) versions.set(bE.hash, fs.readFileSync(bE.path));

    // 内容保持双份: 每个版本都以内容哈希副本写入两侧目录
    for (const [hash, content] of versions) {
      for (const dir of [dirA, dirB]) {
        writeIfChanged(path.join(dir, `${base}.${hash.slice(0, 8)}.csv`), content);
      }
    }

    // 同一冲突证书写入两侧, 内容逐字节相同
    const certDoc = stableStringify({ ...cert, resolution: strategy }) + '\n';
    for (const dir of [dirA, dirB]) {
      fs.writeFileSync(path.join(dir, `${base}.conflict.json`), certDoc);
    }

    if (strategy === 'keep-both') {
      if (aE) fs.unlinkSync(aE.path);
      if (bE) fs.unlinkSync(bE.path);
      const tomb = { deleted: true, hash: null, mtimeMs: Date.now(), note: 'resolved-keep-both', certId: cert.certId };
      stateA.entries[c.key] = tomb;
      stateB.entries[c.key] = { ...tomb };
    } else {
      const winner = strategy === 'a' ? aE : bE;
      if (!winner) throw new SyncError(2, `策略 ${strategy} 需要该侧存在键 ${c.key}`);
      const content = fs.readFileSync(winner.path);
      for (const dir of [dirA, dirB]) writeIfChanged(path.join(dir, fileName), content);
      const rec = {
        hash: winner.hash, deleted: false, mtimeMs: winner.mtimeMs,
        vec: { a: winner.mtimeMs, b: winner.mtimeMs },
        note: `resolved-${strategy}`, certId: cert.certId,
      };
      stateA.entries[c.key] = rec;
      stateB.entries[c.key] = { ...rec };
    }
    certificates.push(cert);
  }

  saveState(dirA, stateA);
  saveState(dirB, stateB);
  return { resolved: conflicts.length, certificates };
}

module.exports = { resolveConflicts };
