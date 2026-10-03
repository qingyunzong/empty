'use strict';

const path = require('node:path');
const { sha256 } = require('./hash');
const { fileNameForKey } = require('./keys');

// Minimal sync plan: exactly one op per actionable change, nothing else.
function makePlan(aDir, bDir, diff) {
  const ops = [];
  for (const c of diff.changes) {
    if (c.op === 'copy') {
      const srcDir = c.from === 'a' ? aDir : bDir;
      const dstDir = c.to === 'a' ? aDir : bDir;
      ops.push({
        op: 'copy', key: c.key, from: c.from, to: c.to, reason: c.reason,
        src: path.join(srcDir, fileNameForKey(c.key)),
        dst: path.join(dstDir, fileNameForKey(c.key)),
        hash: c.hash, size: c.size,
      });
    } else if (c.op === 'delete') {
      const dir = c.side === 'a' ? aDir : bDir;
      ops.push({
        op: 'delete', key: c.key, side: c.side, reason: c.reason,
        path: path.join(dir, fileNameForKey(c.key)), hash: c.hash,
      });
    }
  }
  const planHash = sha256(JSON.stringify({ ops, conflicts: diff.conflicts.map((c) => c.certHash) }));
  ops.forEach((op, i) => { op.id = `${planHash.slice(0, 12)}#${i}`; });
  return {
    version: 1,
    aDir, bDir,
    planHash,
    ops,
    conflicts: diff.conflicts,
    errors: diff.errors,
  };
}

module.exports = { makePlan };
