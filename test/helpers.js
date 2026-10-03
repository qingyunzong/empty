'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'delta-test-'));
}

function writeTree(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, typeof content === 'string' ? Buffer.from(content, 'utf8') : content);
  }
}

function readTree(root) {
  const out = new Map();
  const walk = (dirAbs, dirRel) => {
    for (const e of fs.readdirSync(dirAbs, { withFileTypes: true })) {
      if (dirRel === '' && e.name.startsWith('.delta-')) continue;
      const rel = dirRel === '' ? e.name : dirRel + '/' + e.name;
      const abs = path.join(dirAbs, e.name);
      if (e.isDirectory()) walk(abs, rel);
      else out.set(rel, fs.readFileSync(abs));
    }
  };
  walk(root, '');
  return out;
}

function treesEqual(a, b) {
  const ta = readTree(a);
  const tb = readTree(b);
  if (ta.size !== tb.size) return false;
  for (const [k, v] of ta) {
    const other = tb.get(k);
    if (!other || !v.equals(other)) return false;
  }
  return true;
}

function dirReader(dir) {
  return (rel, offset, size) => {
    const fd = fs.openSync(path.join(dir, rel), 'r');
    try {
      const buf = Buffer.alloc(size);
      let read = 0;
      while (read < size) read += fs.readSync(fd, buf, read, size - read, offset + read);
      return buf;
    } finally {
      fs.closeSync(fd);
    }
  };
}

module.exports = { tmpdir, writeTree, readTree, treesEqual, dirReader };
