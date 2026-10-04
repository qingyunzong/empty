'use strict';

const fs = require('fs');

// Append-only JSONL journal. Recovery truncates a torn tail: a crash during
// append can leave a partial final line, which is discarded so only fully
// written ops are replayed.

function appendOp(file, op) {
  fs.appendFileSync(file, JSON.stringify(op) + '\n');
}

function readOps(file) {
  if (!fs.existsSync(file)) return { ops: [], truncated: false };
  const raw = fs.readFileSync(file, 'utf8');
  const ops = [];
  let truncated = false;
  let offset = 0;
  for (const line of raw.split('\n')) {
    if (line.length === 0) {
      offset += 1;
      continue;
    }
    try {
      ops.push(JSON.parse(line));
    } catch {
      truncated = true;
      break;
    }
    offset += line.length + 1;
  }
  if (truncated) fs.writeFileSync(file, raw.slice(0, offset));
  return { ops, truncated };
}

module.exports = { appendOp, readOps };
