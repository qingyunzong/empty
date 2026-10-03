'use strict';

const { scanDir, sha256 } = require('./manifest');
const { errGap, errHash } = require('./errors');

function coverageProof(manifest) {
  const proof = [];
  let bytes = 0;
  for (const f of manifest.files) {
    const chunks = [...f.chunks].sort((a, b) => a.offset - b.offset);
    const spans = [];
    let pos = 0;
    for (const c of chunks) {
      if (c.offset > pos) {
        throw errGap('uncovered byte range in file', {
          path: f.path,
          gapStart: pos,
          gapEnd: c.offset,
        });
      }
      if (c.offset < pos) {
        throw errGap('overlapping chunks in file', { path: f.path, offset: c.offset });
      }
      spans.push([c.offset, c.size]);
      pos += c.size;
    }
    if (pos !== f.size) {
      throw errGap('file not fully covered by chunks', {
        path: f.path,
        size: f.size,
        covered: pos,
      });
    }
    bytes += f.size;
    proof.push({ path: f.path, size: f.size, spans });
  }
  return {
    root: manifest.root,
    files: manifest.files.length,
    bytes,
    coverage: 'complete',
    coverageHash: sha256(Buffer.from(JSON.stringify(proof), 'utf8')),
    proof,
  };
}

// expected: delta object (uses targetRoot), manifest object (uses root),
// root hash string, or null/undefined (coverage proof only).
function certify(targetDir, expected, opts = {}) {
  const expectedRoot =
    typeof expected === 'string' ? expected : expected && (expected.targetRoot || expected.root);
  const chunkSize = opts.chunkSize || (expected && expected.chunkSize) || undefined;
  const manifest = scanDir(targetDir, { chunkSize });

  if (expectedRoot && manifest.root !== expectedRoot) {
    throw errHash('target root hash mismatch', {
      expected: expectedRoot,
      actual: manifest.root,
    });
  }

  return coverageProof(manifest);
}

module.exports = { certify, coverageProof };
