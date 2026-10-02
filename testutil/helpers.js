'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { blockFileName } = require('../lib/archive');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'arc-repair-'));
}

function blockFile(arcDir, index) {
  return path.join(arcDir, 'blocks', blockFileName(index));
}

function corruptByte(arcDir, index, pos, xor = 0xff) {
  const file = blockFile(arcDir, index);
  const buf = fs.readFileSync(file);
  buf[pos] ^= xor;
  fs.writeFileSync(file, buf);
}

function snapshotTree(dir) {
  const out = {};
  const walk = (d) => {
    for (const name of fs.readdirSync(d).sort()) {
      const p = path.join(d, name);
      if (fs.statSync(p).isDirectory()) walk(p);
      else out[path.relative(dir, p)] = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
    }
  };
  walk(dir);
  return out;
}

function leftoverTempFiles(arcDir) {
  return fs.readdirSync(path.join(arcDir, 'blocks')).filter((n) => n.includes('.repair-'));
}

module.exports = { tmpdir, blockFile, corruptByte, snapshotTree, leftoverTempFiles };
