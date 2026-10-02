'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { adler32hex } = require('./adler32');

class ArchiveError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ArchiveError';
    this.code = code;
  }
}

const MANIFEST = 'manifest.json';
const BLOCKS_DIR = 'blocks';
const HEX32 = /^[0-9a-f]{8}$/;
const HEX64 = /^[0-9a-f]{64}$/;

function sha256hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function blockFileName(index) {
  return String(index).padStart(6, '0') + '.bin';
}

function ioError(message, cause) {
  const err = new ArchiveError('ERR_IO', message);
  if (cause) err.cause = cause;
  return err;
}

function readManifest(arcDir, fsx = fs) {
  const file = path.join(arcDir, MANIFEST);
  let raw;
  try {
    raw = fsx.readFileSync(file, 'utf8');
  } catch (e) {
    throw ioError(`cannot read manifest: ${file}`, e);
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    throw ioError(`manifest is not valid JSON: ${file}`, e);
  }
  validateManifest(data, file);
  return data;
}

function validateManifest(data, file) {
  const bad = (m) => {
    throw new ArchiveError('ERR_CRC', `invalid manifest ${file}: ${m}`);
  };
  if (!data || typeof data !== 'object') bad('not an object');
  if (data.version !== 1) bad('unsupported version');
  if (!Array.isArray(data.blocks)) bad('blocks must be an array');
  data.blocks.forEach((entry, i) => {
    if (!entry || typeof entry !== 'object') bad(`block ${i}: not an object`);
    if (!Number.isInteger(entry.index) || entry.index !== i) bad(`block ${i}: index mismatch`);
    if (!Number.isInteger(entry.length) || entry.length < 0) bad(`block ${i}: bad length`);
    if (typeof entry.adler32 !== 'string' || !HEX32.test(entry.adler32)) bad(`block ${i}: bad adler32`);
    if (typeof entry.sha256 !== 'string' || !HEX64.test(entry.sha256)) bad(`block ${i}: bad sha256`);
  });
}

function createArchive(dir, buffers, fsx = fs) {
  fsx.mkdirSync(path.join(dir, BLOCKS_DIR), { recursive: true });
  const blocks = buffers.map((buf, i) => {
    const data = Buffer.from(buf);
    fsx.writeFileSync(path.join(dir, BLOCKS_DIR, blockFileName(i)), data);
    return {
      index: i,
      length: data.length,
      adler32: adler32hex(data),
      sha256: sha256hex(data),
    };
  });
  const manifest = { version: 1, blockCount: blocks.length, blocks };
  fsx.writeFileSync(path.join(dir, MANIFEST), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}

// Damage rule: a block counts as damaged only when the weak rolling checksum
// fails AND the strong hash fails. A weak mismatch with a valid strong hash is
// a false alarm; a strong mismatch with a valid weak checksum is left untouched.
function inspectArchive(arcDir, fsx = fs) {
  const manifest = readManifest(arcDir, fsx);
  const details = manifest.blocks.map((entry) => {
    const file = path.join(arcDir, BLOCKS_DIR, blockFileName(entry.index));
    let data = null;
    let missing = false;
    try {
      data = fsx.readFileSync(file);
    } catch (e) {
      if (e && e.code === 'ENOENT') missing = true;
      else throw ioError(`cannot read block file: ${file}`, e);
    }
    let weakOk = false;
    let strongOk = false;
    if (!missing) {
      const lengthOk = data.length === entry.length;
      weakOk = lengthOk && adler32hex(data) === entry.adler32;
      strongOk = lengthOk && sha256hex(data) === entry.sha256;
    }
    const damaged = !weakOk && !strongOk;
    return {
      index: entry.index,
      length: entry.length,
      adler32: entry.adler32,
      sha256: entry.sha256,
      weakOk,
      strongOk,
      missing,
      status: damaged ? 'damaged' : 'ok',
    };
  });
  const damaged = details.filter((d) => d.status === 'damaged').map((d) => d.index);
  return {
    archive: arcDir,
    blockCount: details.length,
    damagedCount: damaged.length,
    damaged,
    details,
  };
}

function verifyArchive(arcDir, fsx = fs) {
  const report = inspectArchive(arcDir, fsx);
  return { archive: arcDir, ok: report.damagedCount === 0, damaged: report.damaged };
}

function collectSources(goodDir, fsx = fs) {
  let stat;
  try {
    stat = fsx.statSync(goodDir);
  } catch (e) {
    throw ioError(`cannot read known-good directory: ${goodDir}`, e);
  }
  if (!stat.isDirectory()) throw ioError(`not a directory: ${goodDir}`);
  const hasManifest = (p) => {
    try {
      return fsx.statSync(path.join(p, MANIFEST)).isFile();
    } catch {
      return false;
    }
  };
  if (hasManifest(goodDir)) return [goodDir];
  return fsx
    .readdirSync(goodDir)
    .map((name) => path.join(goodDir, name))
    .filter((p) => {
      try {
        return fsx.statSync(p).isDirectory();
      } catch {
        return false;
      }
    })
    .filter(hasManifest)
    .sort();
}

function readBlockFileOrNull(file, fsx) {
  try {
    return fsx.readFileSync(file);
  } catch {
    return null;
  }
}

function findSourceForBlock(sourceManifests, index, expectedSha, fsx) {
  const candidates = [];
  for (const src of sourceManifests) {
    const entry = src.manifest.blocks[index];
    if (entry && entry.sha256 === expectedSha) {
      const file = path.join(src.dir, BLOCKS_DIR, blockFileName(index));
      const content = readBlockFileOrNull(file, fsx);
      if (content !== null) candidates.push({ file, content });
    }
  }
  if (candidates.length === 0) return null;
  for (let i = 1; i < candidates.length; i++) {
    if (!candidates[i].content.equals(candidates[0].content)) {
      throw new ArchiveError(
        'ERR_SOURCE',
        `conflicting sources for block ${index} (sha256 ${expectedSha}): ` +
          `${candidates[0].file} vs ${candidates[i].file}`
      );
    }
  }
  const content = candidates[0].content;
  if (sha256hex(content) !== expectedSha) return null;
  return { source: candidates[0].file, bytes: content.length };
}

function planRepair(arcDir, goodDir, maxBytes, fsx = fs) {
  if (!Number.isInteger(maxBytes) || maxBytes < 0) {
    throw new ArchiveError('ERR_BUDGET', `maxBytes must be a non-negative integer, got: ${maxBytes}`);
  }
  const manifest = readManifest(arcDir, fsx);
  const report = inspectArchive(arcDir, fsx);
  const damaged = report.damaged.slice().sort((a, b) => a - b);
  const repairs = [];
  const skipped = [];
  let usedBytes = 0;
  if (damaged.length > 0) {
    const sources = collectSources(goodDir, fsx).map((dir) => ({
      dir,
      manifest: readManifest(dir, fsx),
    }));
    let stopped = false;
    for (const index of damaged) {
      if (stopped) {
        skipped.push({ index, reason: 'prefix' });
        continue;
      }
      const entry = manifest.blocks[index];
      const found = findSourceForBlock(sources, index, entry.sha256, fsx);
      if (!found) {
        skipped.push({ index, reason: 'no-source' });
        stopped = true;
        continue;
      }
      if (usedBytes + entry.length > maxBytes) {
        skipped.push({ index, reason: 'budget' });
        stopped = true;
        continue;
      }
      repairs.push({
        index,
        length: entry.length,
        sha256: entry.sha256,
        source: path.resolve(found.source),
        bytes: entry.length,
      });
      usedBytes += entry.length;
    }
  }
  return {
    version: 1,
    archive: path.resolve(arcDir),
    budget: { maxBytes, usedBytes },
    repairs,
    skipped,
  };
}

function validatePlan(plan) {
  const bad = (m) => {
    throw new ArchiveError('ERR_CRC', `invalid plan: ${m}`);
  };
  if (!plan || typeof plan !== 'object') bad('not an object');
  if (plan.version !== 1) bad('unsupported version');
  if (
    !plan.budget ||
    !Number.isInteger(plan.budget.maxBytes) ||
    plan.budget.maxBytes < 0 ||
    !Number.isInteger(plan.budget.usedBytes) ||
    plan.budget.usedBytes < 0
  ) {
    throw new ArchiveError('ERR_BUDGET', 'invalid plan budget');
  }
  if (!Array.isArray(plan.repairs)) bad('repairs must be an array');
  let sum = 0;
  let prev = -1;
  for (const r of plan.repairs) {
    if (!r || typeof r !== 'object') bad('repair entry not an object');
    if (!Number.isInteger(r.index) || r.index < 0) bad('bad repair index');
    if (r.index <= prev) bad('repairs not sorted by index');
    prev = r.index;
    if (!Number.isInteger(r.length) || r.length < 0) bad('bad repair length');
    if (typeof r.sha256 !== 'string' || !HEX64.test(r.sha256)) bad('bad repair sha256');
    if (typeof r.source !== 'string' || r.source.length === 0) bad('bad repair source');
    sum += r.length;
  }
  if (sum !== plan.budget.usedBytes) {
    throw new ArchiveError('ERR_BUDGET', 'usedBytes does not match repairs');
  }
  if (plan.budget.usedBytes > plan.budget.maxBytes) {
    throw new ArchiveError('ERR_BUDGET', 'plan exceeds budget');
  }
}

// Applies a plan atomically: every replacement block is staged as a temp file
// and fsynced before any original is touched; originals are backed up and
// restored if the commit phase fails midway.
function applyPlan(arcDir, planOrFile, fsx = fs) {
  let plan = planOrFile;
  if (typeof planOrFile === 'string') {
    let raw;
    try {
      raw = fsx.readFileSync(planOrFile, 'utf8');
    } catch (e) {
      throw ioError(`cannot read plan: ${planOrFile}`, e);
    }
    try {
      plan = JSON.parse(raw);
    } catch (e) {
      throw ioError(`plan is not valid JSON: ${planOrFile}`, e);
    }
  }
  validatePlan(plan);
  const manifest = readManifest(arcDir, fsx);
  const payloads = plan.repairs.map((repair) => {
    const entry = manifest.blocks[repair.index];
    if (!entry || entry.sha256 !== repair.sha256 || entry.length !== repair.length) {
      throw new ArchiveError('ERR_CRC', `plan does not match archive manifest at block ${repair.index}`);
    }
    let content;
    try {
      content = fsx.readFileSync(repair.source);
    } catch (e) {
      throw ioError(`cannot read source: ${repair.source}`, e);
    }
    if (content.length !== repair.length || sha256hex(content) !== repair.sha256) {
      throw new ArchiveError('ERR_SOURCE', `source content mismatch for block ${repair.index}: ${repair.source}`);
    }
    return { repair, content };
  });

  const blocksDir = path.join(arcDir, BLOCKS_DIR);
  const staged = [];
  try {
    for (const { repair, content } of payloads) {
      const tmp = path.join(blocksDir, `.repair-${blockFileName(repair.index)}.tmp`);
      staged.push(tmp);
      const fd = fsx.openSync(tmp, 'w');
      try {
        fsx.writeSync(fd, content);
        fsx.fsyncSync(fd);
      } finally {
        fsx.closeSync(fd);
      }
    }
  } catch (e) {
    for (const tmp of staged) {
      try {
        fsx.unlinkSync(tmp);
      } catch {}
    }
    if (e instanceof ArchiveError) throw e;
    throw ioError(`failed to stage repaired blocks: ${e.message}`, e);
  }

  const done = [];
  try {
    for (const { repair } of payloads) {
      const name = blockFileName(repair.index);
      const orig = path.join(blocksDir, name);
      const bak = path.join(blocksDir, `.repair-${name}.bak`);
      const tmp = path.join(blocksDir, `.repair-${name}.tmp`);
      let backedUp = false;
      try {
        fsx.renameSync(orig, bak);
        backedUp = true;
      } catch (e) {
        if (!e || e.code !== 'ENOENT') throw e;
      }
      try {
        fsx.renameSync(tmp, orig);
      } catch (e) {
        if (backedUp) {
          try {
            fsx.renameSync(bak, orig);
          } catch {}
        }
        throw e;
      }
      done.push({ orig, bak, backedUp });
    }
  } catch (e) {
    for (const d of done.reverse()) {
      try {
        fsx.unlinkSync(d.orig);
      } catch {}
      if (d.backedUp) {
        try {
          fsx.renameSync(d.bak, d.orig);
        } catch {}
      }
    }
    for (const tmp of staged) {
      try {
        fsx.unlinkSync(tmp);
      } catch {}
    }
    if (e instanceof ArchiveError) throw e;
    throw ioError(`failed to commit repaired blocks: ${e.message}`, e);
  }
  for (const d of done) {
    if (d.backedUp) {
      try {
        fsx.unlinkSync(d.bak);
      } catch {}
    }
  }
  return { archive: path.resolve(arcDir), applied: payloads.length, bytes: plan.budget.usedBytes };
}

module.exports = {
  ArchiveError,
  blockFileName,
  sha256hex,
  createArchive,
  readManifest,
  inspectArchive,
  verifyArchive,
  planRepair,
  applyPlan,
};
