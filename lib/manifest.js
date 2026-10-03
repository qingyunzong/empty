'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { errPath } = require('./errors');

const DEFAULT_CHUNK_SIZE = 64 * 1024;
const INTERNAL_PREFIX = '.delta-';

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function comparePathBytes(a, b) {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

function normalizePath(p) {
  if (typeof p !== 'string' || p.length === 0) {
    throw errPath('path must be a non-empty string', { path: String(p) });
  }
  if (p.includes('\0')) throw errPath('path contains NUL byte', { path: p });
  if (p.includes('\\')) throw errPath('path contains backslash separator', { path: p });
  if (p.startsWith('/')) throw errPath('absolute paths are not allowed', { path: p });
  const parts = p.split('/');
  for (const part of parts) {
    if (part === '') throw errPath('path contains empty component', { path: p });
    if (part === '.' || part === '..') throw errPath('path contains dot component', { path: p });
  }
  return parts.join('/');
}

function assertNoCaseConflict(paths) {
  const seen = new Map();
  const full = new Set();
  for (const p of paths) {
    if (full.has(p)) {
      throw errPath('duplicate path', { path: p });
    }
    full.add(p);
    const parts = p.split('/');
    for (let i = 1; i <= parts.length; i++) {
      const original = parts.slice(0, i).join('/');
      const key = original.normalize('NFC').toLowerCase();
      if (seen.has(key) && seen.get(key) !== original) {
        throw errPath('duplicate or case-conflicting path', { a: seen.get(key), b: original });
      }
      seen.set(key, original);
    }
  }
}

function computeRoot(manifest) {
  const lines = manifest.files.map((f) =>
    JSON.stringify([f.path, f.mode, f.size, f.chunks.map((c) => [c.offset, c.size, c.sha256])]));
  return sha256(Buffer.from(lines.join('\n'), 'utf8'));
}

function scanDir(root, opts = {}) {
  const chunkSize = opts.chunkSize || DEFAULT_CHUNK_SIZE;
  let stat;
  try {
    stat = fs.statSync(root);
  } catch {
    throw errPath('directory does not exist', { path: root });
  }
  if (!stat.isDirectory()) throw errPath('not a directory', { path: root });

  const relPaths = [];
  const walk = (dirAbs, dirRel) => {
    const entries = fs.readdirSync(dirAbs, { withFileTypes: true })
      .sort((x, y) => comparePathBytes(x.name, y.name));
    for (const e of entries) {
      if (dirRel === '' && e.name.startsWith(INTERNAL_PREFIX)) continue;
      const rel = dirRel === '' ? e.name : dirRel + '/' + e.name;
      if (e.isDirectory()) {
        walk(path.join(dirAbs, e.name), rel);
      } else if (e.isFile()) {
        relPaths.push(rel);
      } else {
        throw errPath('unsupported file type (symlink or special file)', { path: rel });
      }
    }
  };
  walk(root, '');

  const files = [];
  for (const rel of relPaths) {
    normalizePath(rel);
    const abs = path.join(root, rel);
    const st = fs.statSync(abs);
    const mode = st.mode & 0o777;
    const data = fs.readFileSync(abs);
    const chunks = [];
    for (let off = 0; off < data.length; off += chunkSize) {
      const slice = data.subarray(off, Math.min(off + chunkSize, data.length));
      chunks.push({ path: rel, mode, offset: off, size: slice.length, sha256: sha256(slice) });
    }
    files.push({ path: rel, mode, size: data.length, chunks });
  }
  files.sort((a, b) => comparePathBytes(a.path, b.path));
  assertNoCaseConflict(files.map((f) => f.path));

  const manifest = { version: 1, chunkSize, files };
  manifest.root = computeRoot(manifest);
  return manifest;
}

function validateManifest(m) {
  if (!m || typeof m !== 'object' || !Array.isArray(m.files)) {
    throw errPath('invalid manifest structure');
  }
  const paths = [];
  for (const f of m.files) {
    normalizePath(f.path);
    paths.push(f.path);
  }
  assertNoCaseConflict(paths);
  return m;
}

module.exports = {
  DEFAULT_CHUNK_SIZE,
  INTERNAL_PREFIX,
  sha256,
  comparePathBytes,
  normalizePath,
  assertNoCaseConflict,
  computeRoot,
  scanDir,
  validateManifest,
};
