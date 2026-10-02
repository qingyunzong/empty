'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const DEFAULT_CHUNK_SIZE = 64 * 1024;
const STATE_FILE = '.apply-state.json';
const TMP_DIR = '.delta-tmp';

class DeltaError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DeltaError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new DeltaError(code, message);
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function comparePathBytes(a, b) {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

function normalizePath(p) {
  if (typeof p !== 'string' || p.length === 0) {
    fail('ERR_PATH', `invalid path: ${String(p)}`);
  }
  if (p.includes('\0')) fail('ERR_PATH', `NUL byte in path: ${JSON.stringify(p)}`);
  if (p.includes('\\')) fail('ERR_PATH', `backslash not allowed in path: ${p}`);
  if (p.startsWith('/') || /^[A-Za-z]:/.test(p)) {
    fail('ERR_PATH', `absolute path not allowed: ${p}`);
  }
  const out = [];
  for (const part of p.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') fail('ERR_PATH', `parent traversal not allowed: ${p}`);
    out.push(part);
  }
  if (out.length === 0) fail('ERR_PATH', `empty path after normalization: ${p}`);
  return out.join('/');
}

function assertCaseUnique(paths) {
  const seen = new Map();
  for (const p of paths) {
    const key = p.toLowerCase();
    if (seen.has(key)) {
      fail('ERR_PATH', `case conflict between paths: ${seen.get(key)} and ${p}`);
    }
    seen.set(key, p);
  }
}

function manifestRoot(files) {
  const h = crypto.createHash('sha256');
  for (const f of files) {
    h.update(Buffer.from(f.path, 'utf8'));
    h.update('\0');
    h.update(f.mode.toString(8));
    h.update('\0');
    h.update(String(f.size));
    h.update('\0');
    for (const c of f.chunks) {
      h.update(`${c.offset}:${c.len}:${c.sha256};`);
    }
    h.update('\n');
  }
  return h.digest('hex');
}

async function readChunk(dir, rel, offset, len) {
  const abs = path.join(dir, ...normalizePath(rel).split('/'));
  const fh = await fsp.open(abs, 'r').catch(() => {
    fail('ERR_STATE', `cannot open source file: ${rel}`);
  });
  try {
    const buf = Buffer.alloc(len);
    const { bytesRead } = await fh.read(buf, 0, len, offset);
    if (bytesRead !== len) {
      fail('ERR_STATE', `short read on ${rel} at offset ${offset}: wanted ${len}, got ${bytesRead}`);
    }
    return buf;
  } finally {
    await fh.close();
  }
}

async function scan(dir, opts = {}) {
  const chunkSize = opts.chunkSize || DEFAULT_CHUNK_SIZE;
  const st = await fsp.stat(dir).catch(() => fail('ERR_PATH', `not a directory: ${dir}`));
  if (!st.isDirectory()) fail('ERR_PATH', `not a directory: ${dir}`);
  const files = [];
  async function walk(abs, rel) {
    const entries = await fsp.readdir(abs, { withFileTypes: true });
    for (const e of entries) {
      const childAbs = path.join(abs, e.name);
      const childRel = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) {
        await walk(childAbs, childRel);
      } else if (e.isFile()) {
        const fst = await fsp.stat(childAbs);
        const chunks = [];
        const fh = await fsp.open(childAbs, 'r');
        try {
          let offset = 0;
          while (offset < fst.size) {
            const want = Math.min(chunkSize, fst.size - offset);
            const buf = Buffer.alloc(want);
            const { bytesRead } = await fh.read(buf, 0, want, offset);
            if (bytesRead === 0) break;
            chunks.push({ offset, len: bytesRead, sha256: sha256(buf.subarray(0, bytesRead)) });
            offset += bytesRead;
          }
        } finally {
          await fh.close();
        }
        files.push({ path: childRel, mode: fst.mode & 0o777, size: fst.size, chunks });
      } else {
        fail('ERR_PATH', `unsupported entry type: ${childRel}`);
      }
    }
  }
  await walk(dir, '');
  files.sort((a, b) => comparePathBytes(a.path, b.path));
  assertCaseUnique(files.map((f) => f.path));
  return { version: 1, chunkSize, root: manifestRoot(files), files };
}

async function makeDelta(src, dst, dstDir) {
  if (!src || !dst || src.version !== 1 || dst.version !== 1) {
    fail('ERR_STATE', 'invalid manifest');
  }
  const index = new Map();
  for (const f of src.files) {
    for (const c of f.chunks) {
      let arr = index.get(c.sha256);
      if (!arr) index.set(c.sha256, (arr = []));
      arr.push({ path: f.path, offset: c.offset, hash: c.sha256 });
    }
  }
  for (const arr of index.values()) {
    arr.sort((a, b) =>
      comparePathBytes(a.path, b.path) ||
      a.offset - b.offset ||
      (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0)
    );
  }

  const blocks = [];
  const blockIndex = new Map();
  const refCounts = new Map();
  const plan = [];
  for (const f of dst.files) {
    const chunks = [];
    for (const c of f.chunks) {
      const candidates = index.get(c.sha256);
      let from;
      if (candidates && candidates.length > 0) {
        const best = candidates[0];
        from = { type: 'keep', path: best.path, offset: best.offset };
      } else {
        if (!blockIndex.has(c.sha256)) {
          if (!dstDir) fail('ERR_STATE', `literal data unavailable for block ${c.sha256}`);
          const data = await readChunk(dstDir, f.path, c.offset, c.len);
          if (sha256(data) !== c.sha256) {
            fail('ERR_HASH', `manifest/data mismatch at ${f.path}@${c.offset}`);
          }
          blockIndex.set(c.sha256, blocks.length);
          blocks.push({ hash: c.sha256, data: data.toString('base64') });
        }
        from = { type: 'literal' };
      }
      refCounts.set(c.sha256, (refCounts.get(c.sha256) || 0) + 1);
      chunks.push({ offset: c.offset, len: c.len, hash: c.sha256, from });
    }
    plan.push({ path: f.path, mode: f.mode, size: f.size, chunks });
  }
  const dstPaths = new Set(dst.files.map((f) => f.path));
  const del = src.files
    .map((f) => f.path)
    .filter((p) => !dstPaths.has(p))
    .sort(comparePathBytes);
  const refCountsObj = Object.fromEntries(
    [...refCounts.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))
  );
  return {
    version: 1,
    chunkSize: dst.chunkSize,
    targetRoot: dst.root,
    blocks,
    plan,
    delete: del,
    refCounts: refCountsObj,
  };
}

function validateDelta(delta) {
  if (!delta || typeof delta !== 'object') fail('ERR_STATE', 'invalid delta');
  if (delta.version !== 1) fail('ERR_STATE', 'unsupported delta version');
  if (typeof delta.targetRoot !== 'string' || !/^[0-9a-f]{64}$/.test(delta.targetRoot)) {
    fail('ERR_STATE', 'invalid targetRoot');
  }
  if (!Array.isArray(delta.plan) || !Array.isArray(delta.delete) || !Array.isArray(delta.blocks)) {
    fail('ERR_STATE', 'invalid delta structure');
  }
  const allPaths = [];
  for (const f of delta.plan) {
    f.path = normalizePath(f.path);
    allPaths.push(f.path);
    if (!Number.isInteger(f.mode) || !Number.isInteger(f.size) || !Array.isArray(f.chunks)) {
      fail('ERR_STATE', `invalid plan entry for ${f.path}`);
    }
    for (const c of f.chunks) {
      if (!Number.isInteger(c.offset) || !Number.isInteger(c.len) || typeof c.hash !== 'string') {
        fail('ERR_STATE', `invalid chunk in ${f.path}`);
      }
      if (!c.from || (c.from.type !== 'keep' && c.from.type !== 'literal')) {
        fail('ERR_STATE', `invalid chunk source in ${f.path}`);
      }
      if (c.from.type === 'keep') {
        c.from.path = normalizePath(c.from.path);
        if (!Number.isInteger(c.from.offset)) fail('ERR_STATE', `invalid keep offset in ${f.path}`);
      }
    }
  }
  for (const b of delta.blocks) {
    if (typeof b.hash !== 'string' || typeof b.data !== 'string') {
      fail('ERR_STATE', 'invalid literal block');
    }
  }
  delta.delete = delta.delete.map((p) => normalizePath(p));
  allPaths.push(...delta.delete);
  assertCaseUnique(allPaths);
}

async function writeState(statePath, state) {
  const tmp = statePath + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(state));
  await fsp.rename(tmp, statePath);
}

async function pruneEmptyDirs(root, abs) {
  let entries;
  try {
    entries = await fsp.readdir(abs, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.isDirectory()) await pruneEmptyDirs(root, path.join(abs, e.name));
  }
  if (abs !== root) {
    await fsp.rmdir(abs).catch(() => {});
  }
}

async function applyDelta(delta, dir, opts = {}) {
  validateDelta(delta);
  const st = await fsp.stat(dir).catch(() => fail('ERR_PATH', `not a directory: ${dir}`));
  if (!st.isDirectory()) fail('ERR_PATH', `not a directory: ${dir}`);

  const statePath = path.join(dir, STATE_FILE);
  const tmpRoot = path.join(dir, TMP_DIR);
  const hook = opts.hook || (() => {});

  let state = null;
  try {
    state = JSON.parse(await fsp.readFile(statePath, 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') fail('ERR_STATE', 'corrupt apply state file');
  }
  if (state) {
    if (state.targetRoot !== delta.targetRoot) {
      fail('ERR_STATE', 'pending apply state belongs to a different delta');
    }
  } else {
    await fsp.rm(tmpRoot, { recursive: true, force: true });
    await fsp.mkdir(tmpRoot, { recursive: true });
    state = { targetRoot: delta.targetRoot, assembled: [], installed: [], deleted: false };
    await writeState(statePath, state);
  }

  const blockMap = new Map(delta.blocks.map((b) => [b.hash, Buffer.from(b.data, 'base64')]));
  for (const [h, buf] of blockMap) {
    if (sha256(buf) !== h) fail('ERR_HASH', `literal block hash mismatch: ${h}`);
  }

  // Phase 1: assemble every target file into the temp dir. Keep-chunk reads
  // happen here while the target dir is still in its pristine source state.
  for (let i = 0; i < delta.plan.length; i++) {
    const f = delta.plan[i];
    const tmpPath = path.join(tmpRoot, String(i));
    if (state.assembled.includes(f.path)) {
      if (!state.installed.includes(f.path)) {
        await fsp.stat(tmpPath).catch(() => fail('ERR_STATE', `missing assembled temp for ${f.path}`));
      }
      continue;
    }
    await hook('assemble', f.path);
    const out = await fsp.open(tmpPath, 'w');
    try {
      for (const c of f.chunks) {
        let data;
        if (c.from.type === 'keep') {
          data = await readChunk(dir, c.from.path, c.from.offset, c.len);
        } else {
          data = blockMap.get(c.hash);
          if (!data) fail('ERR_STATE', `missing literal block ${c.hash}`);
        }
        if (data.length !== c.len || sha256(data) !== c.hash) {
          fail('ERR_HASH', `chunk hash mismatch for ${f.path}@${c.offset}`);
        }
        await out.write(data);
      }
    } finally {
      await out.close();
    }
    state.assembled.push(f.path);
    await writeState(statePath, state);
  }

  // Phase 2: atomically rename assembled files into place.
  for (let i = 0; i < delta.plan.length; i++) {
    const f = delta.plan[i];
    if (state.installed.includes(f.path)) continue;
    await hook('install', f.path);
    const dest = path.join(dir, ...f.path.split('/'));
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.rename(path.join(tmpRoot, String(i)), dest);
    await fsp.chmod(dest, f.mode);
    state.installed.push(f.path);
    await writeState(statePath, state);
  }

  // Phase 3: deletions.
  if (!state.deleted) {
    for (const p of delta.delete) {
      await hook('delete', p);
      await fsp.rm(path.join(dir, ...p.split('/')), { force: true });
    }
    state.deleted = true;
    await writeState(statePath, state);
  }

  await fsp.rm(tmpRoot, { recursive: true, force: true });
  await pruneEmptyDirs(dir, dir);
  await fsp.rm(statePath, { force: true });
  return {
    applied: true,
    targetRoot: delta.targetRoot,
    files: delta.plan.length,
    deleted: delta.delete.length,
  };
}

async function certify(dir, delta) {
  validateDelta(delta);
  const proof = {
    ok: true,
    targetRoot: delta.targetRoot,
    files: [],
    totalFiles: 0,
    totalChunks: 0,
    totalCoveredBytes: 0,
  };
  for (const f of delta.plan) {
    const abs = path.join(dir, ...f.path.split('/'));
    const st = await fsp.stat(abs).catch(() => fail('ERR_STATE', `missing file: ${f.path}`));
    if (st.size !== f.size) {
      fail('ERR_GAP', `size mismatch for ${f.path}: expected ${f.size}, got ${st.size}`);
    }
    const ordered = [...f.chunks].sort((a, b) => a.offset - b.offset);
    let cursor = 0;
    const fh = await fsp.open(abs, 'r');
    try {
      for (const c of ordered) {
        if (c.offset !== cursor) {
          fail('ERR_GAP', `uncovered byte range in ${f.path} at offset ${cursor}`);
        }
        const buf = Buffer.alloc(c.len);
        const { bytesRead } = await fh.read(buf, 0, c.len, c.offset);
        if (bytesRead !== c.len) {
          fail('ERR_GAP', `uncovered byte range in ${f.path} at offset ${c.offset}`);
        }
        if (sha256(buf) !== c.hash) {
          fail('ERR_HASH', `hash mismatch in ${f.path}@${c.offset}`);
        }
        cursor += c.len;
      }
    } finally {
      await fh.close();
    }
    if (cursor !== f.size) {
      fail('ERR_GAP', `uncovered byte range in ${f.path} at offset ${cursor}`);
    }
    proof.files.push({ path: f.path, size: f.size, chunks: ordered.length, coveredBytes: cursor });
    proof.totalFiles += 1;
    proof.totalChunks += ordered.length;
    proof.totalCoveredBytes += cursor;
  }
  const m = await scan(dir, { chunkSize: delta.chunkSize || DEFAULT_CHUNK_SIZE });
  proof.computedRoot = m.root;
  if (m.root !== delta.targetRoot) {
    fail('ERR_HASH', `root mismatch: expected ${delta.targetRoot}, got ${m.root}`);
  }
  return proof;
}

module.exports = {
  DEFAULT_CHUNK_SIZE,
  DeltaError,
  scan,
  makeDelta,
  applyDelta,
  certify,
  normalizePath,
  manifestRoot,
};
