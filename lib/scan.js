'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { parseFileName } = require('./keys');
const { hashFile } = require('./hash');

// Scan a settlement directory. Returns Map key -> {path, hash, size, mtimeMs}.
// Dot entries (.sync/) and non-settlement files are ignored.
function scanDir(dir) {
  const out = new Map();
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return out;
    throw err;
  }
  for (const ent of entries) {
    if (!ent.isFile() || ent.name.startsWith('.')) continue;
    const parsed = parseFileName(ent.name);
    if (!parsed) continue;
    const p = path.join(dir, ent.name);
    const st = fs.statSync(p);
    out.set(parsed.key, {
      path: p,
      hash: hashFile(p),
      size: st.size,
      mtimeMs: st.mtimeMs,
    });
  }
  return out;
}

module.exports = { scanDir };
