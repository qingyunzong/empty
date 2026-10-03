'use strict';

const fs = require('fs');
const path = require('path');
const { scanDir, sha256, normalizePath, assertNoCaseConflict } = require('./manifest');
const { errPath, errHash, errState } = require('./errors');

const JOURNAL_NAME = '.delta-apply.journal';
const STAGING_NAME = '.delta-apply-staging';
const MANIFEST_NAME = '.delta-manifest.json';

function readChunkFromDir(dir, rel, offset, size) {
  const fd = fs.openSync(path.join(dir, rel), 'r');
  try {
    const buf = Buffer.alloc(size);
    let read = 0;
    while (read < size) {
      read += fs.readSync(fd, buf, read, size - read, offset + read);
    }
    return buf;
  } finally {
    fs.closeSync(fd);
  }
}

function validateDelta(delta) {
  if (!delta || typeof delta !== 'object') throw errState('delta must be an object');
  if (delta.version !== 1) throw errState('unsupported delta version', { version: delta.version });
  if (typeof delta.baseRoot !== 'string' || typeof delta.targetRoot !== 'string') {
    throw errState('delta is missing base/target root hashes');
  }
  if (!Array.isArray(delta.deletes) || !Array.isArray(delta.files)) {
    throw errState('delta is missing deletes/files lists');
  }
  const paths = [];
  for (const p of delta.deletes) paths.push(normalizePath(p));
  for (const f of delta.files) {
    normalizePath(f.path);
    paths.push(f.path);
    if (!Number.isInteger(f.mode) || !Number.isInteger(f.size)) {
      throw errState('delta file entry missing mode/size', { path: f.path });
    }
    if (!Array.isArray(f.chunks)) throw errState('delta file entry missing chunks', { path: f.path });
    for (const c of f.chunks) {
      if (c.src !== 'reuse' && c.src !== 'literal') {
        throw errState('unknown chunk source', { path: f.path, src: c.src });
      }
      const table = c.src === 'reuse' ? delta.reuse : delta.literals;
      if (!table || !table[c.sha256]) {
        throw errState('chunk references missing entry', { path: f.path, hash: c.sha256 });
      }
    }
  }
  assertNoCaseConflict(paths);
  const delSet = new Set(delta.deletes);
  for (const f of delta.files) {
    if (delSet.has(f.path)) {
      throw errState('path appears in both deletes and files', { path: f.path });
    }
  }
}

function writeManifestAtomically(targetDir, manifest) {
  const tmp = path.join(targetDir, MANIFEST_NAME + '.tmp');
  const final = path.join(targetDir, MANIFEST_NAME);
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, JSON.stringify(manifest, null, 2) + '\n');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, final);
}

function commit(targetDir, stagingDir, journal) {
  for (const rel of journal.files) {
    const staged = path.join(stagingDir, rel);
    const final = path.join(targetDir, rel);
    if (fs.existsSync(staged)) {
      fs.mkdirSync(path.dirname(final), { recursive: true });
      fs.renameSync(staged, final);
    } else if (!fs.existsSync(final)) {
      throw errState('staged file and final file both missing during commit', { path: rel });
    }
  }
  for (const rel of journal.deletes) {
    fs.rmSync(path.join(targetDir, rel), { force: true });
    let dir = path.dirname(path.join(targetDir, rel));
    while (dir !== targetDir && dir.startsWith(targetDir)) {
      try {
        fs.rmdirSync(dir);
      } catch {
        break;
      }
      dir = path.dirname(dir);
    }
  }
}

function finalize(targetDir, stagingDir, journalPath, journal, chunkSize) {
  commit(targetDir, stagingDir, journal);
  const finalManifest = scanDir(targetDir, { chunkSize });
  if (finalManifest.root !== journal.targetRoot) {
    throw errState('post-apply verification failed', {
      expected: journal.targetRoot,
      actual: finalManifest.root,
    });
  }
  writeManifestAtomically(targetDir, finalManifest);
  fs.rmSync(journalPath, { force: true });
  fs.rmSync(stagingDir, { recursive: true, force: true });
  return finalManifest;
}

function applyDelta(delta, targetDir) {
  validateDelta(delta);
  const journalPath = path.join(targetDir, JOURNAL_NAME);
  const stagingDir = path.join(targetDir, STAGING_NAME);

  if (fs.existsSync(journalPath)) {
    const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
    finalize(targetDir, stagingDir, journalPath, journal, delta.chunkSize);
  } else if (fs.existsSync(stagingDir)) {
    fs.rmSync(stagingDir, { recursive: true, force: true });
  }

  const current = scanDir(targetDir, { chunkSize: delta.chunkSize });
  if (current.root === delta.targetRoot) {
    writeManifestAtomically(targetDir, current);
    return { status: 'already-applied', root: current.root };
  }
  if (current.root !== delta.baseRoot) {
    throw errState('target directory does not match delta base state', {
      expected: delta.baseRoot,
      actual: current.root,
    });
  }

  fs.mkdirSync(stagingDir, { recursive: true });
  try {
    for (const f of delta.files) {
      const parts = [];
      for (const c of f.chunks) {
        let buf;
        if (c.src === 'reuse') {
          const r = delta.reuse[c.sha256];
          buf = readChunkFromDir(targetDir, r.path, r.offset, r.size);
        } else {
          buf = Buffer.from(delta.literals[c.sha256].data, 'base64');
        }
        if (buf.length !== c.size || sha256(buf) !== c.sha256) {
          throw errHash('chunk hash mismatch while staging', {
            path: f.path,
            offset: c.offset,
            expected: c.sha256,
          });
        }
        parts.push(buf);
      }
      const stagedPath = path.join(stagingDir, f.path);
      fs.mkdirSync(path.dirname(stagedPath), { recursive: true });
      fs.writeFileSync(stagedPath, Buffer.concat(parts));
      fs.chmodSync(stagedPath, f.mode);
    }
  } catch (e) {
    fs.rmSync(stagingDir, { recursive: true, force: true });
    throw e;
  }

  const journal = {
    version: 1,
    targetRoot: delta.targetRoot,
    files: delta.files.map((f) => f.path),
    deletes: delta.deletes.slice(),
  };
  const fd = fs.openSync(journalPath, 'w');
  try {
    fs.writeSync(fd, JSON.stringify(journal));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }

  if (process.env.DELTA_APPLY_FAIL === 'after-journal') {
    throw errState('injected apply failure after journal write');
  }

  const finalManifest = finalize(targetDir, stagingDir, journalPath, journal, delta.chunkSize);
  return { status: 'applied', root: finalManifest.root };
}

module.exports = { applyDelta, validateDelta, JOURNAL_NAME, STAGING_NAME, MANIFEST_NAME };
