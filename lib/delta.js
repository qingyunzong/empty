'use strict';

const { comparePathBytes, validateManifest } = require('./manifest');
const { errState } = require('./errors');

function compareChunkRef(a, b) {
  const byPath = comparePathBytes(a.path, b.path);
  if (byPath !== 0) return byPath;
  if (a.offset !== b.offset) return a.offset - b.offset;
  return a.sha256 < b.sha256 ? -1 : a.sha256 > b.sha256 ? 1 : 0;
}

// readChunk(path, offset, size) -> Buffer, used to fetch literal bytes
// from the target tree. Required whenever the target introduces content
// that does not exist in the source manifest.
function makeDelta(srcManifest, tgtManifest, readChunk) {
  validateManifest(srcManifest);
  validateManifest(tgtManifest);
  if (srcManifest.chunkSize !== tgtManifest.chunkSize) {
    throw errState('chunk size mismatch between manifests', {
      source: srcManifest.chunkSize,
      target: tgtManifest.chunkSize,
    });
  }

  const byHash = new Map();
  for (const f of srcManifest.files) {
    for (const c of f.chunks) {
      let arr = byHash.get(c.sha256);
      if (!arr) {
        arr = [];
        byHash.set(c.sha256, arr);
      }
      arr.push({ path: c.path, offset: c.offset, size: c.size, sha256: c.sha256 });
    }
  }
  for (const arr of byHash.values()) arr.sort(compareChunkRef);

  const tgtPaths = new Set(tgtManifest.files.map((f) => f.path));
  const deletes = srcManifest.files
    .map((f) => f.path)
    .filter((p) => !tgtPaths.has(p))
    .sort(comparePathBytes);

  const reuse = {};
  const literals = {};
  const files = [];

  for (const f of tgtManifest.files) {
    const chunks = [];
    for (const c of f.chunks) {
      const candidates = byHash.get(c.sha256);
      if (candidates) {
        const best = candidates[0];
        let r = reuse[c.sha256];
        if (!r) {
          r = reuse[c.sha256] = { path: best.path, offset: best.offset, size: best.size, refs: 0 };
        }
        r.refs += 1;
        chunks.push({ offset: c.offset, size: c.size, sha256: c.sha256, src: 'reuse' });
      } else {
        let l = literals[c.sha256];
        if (!l) {
          if (typeof readChunk !== 'function') {
            throw errState('literal chunk content unavailable (no target reader)', {
              path: f.path,
              offset: c.offset,
            });
          }
          const data = readChunk(f.path, c.offset, c.size);
          l = literals[c.sha256] = { size: c.size, refs: 0, data: data.toString('base64') };
        }
        l.refs += 1;
        chunks.push({ offset: c.offset, size: c.size, sha256: c.sha256, src: 'literal' });
      }
    }
    files.push({ path: f.path, mode: f.mode, size: f.size, chunks });
  }

  return {
    version: 1,
    chunkSize: tgtManifest.chunkSize,
    baseRoot: srcManifest.root,
    targetRoot: tgtManifest.root,
    deletes,
    reuse,
    literals,
    files,
  };
}

module.exports = { makeDelta, compareChunkRef };
