#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const { Pool, PoolError } = require('./lib/pool.js');

function runOp(pool, op) {
  switch (op.op) {
    case 'addNode': return pool.addNode(op.path, op.limit);
    case 'reserve': return pool.reserve(op.path, op.amount, op.holdId);
    case 'batchReserve': return pool.batchReserve(op.items || []);
    case 'commit': return pool.commit(op.holdId);
    case 'abort': return pool.abort(op.holdId);
    case 'subtreeExposure': return pool.subtreeExposure(op.path || '');
    default: throw new PoolError('E_BAD_OP', `unknown op: ${op.op}`);
  }
}

// Returns process exit code; io defaults to real stdout/stderr.
function run(argv, io = process) {
  const [cmd, file, ...rest] = argv;
  if (cmd !== 'exec' || !file) {
    io.stderr.write('usage: pool exec <ops.jsonl> [--stats]\n');
    return 2;
  }
  const wantStats = rest.includes('--stats');

  const pool = new Pool();
  const stats = { ops: 0, reserves: 0, commits: 0, aborts: 0, batches: 0 };
  const lines = fs.readFileSync(file, 'utf8').split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      const op = JSON.parse(line);
      const result = runOp(pool, op);
      stats.ops++;
      if (op.op === 'reserve') stats.reserves++;
      if (op.op === 'commit') stats.commits++;
      if (op.op === 'abort') stats.aborts++;
      if (op.op === 'batchReserve') stats.batches++;
      io.stdout.write(JSON.stringify({ ok: true, line: i + 1, result }) + '\n');
    } catch (err) {
      const code = err instanceof PoolError ? err.code : 'E_INTERNAL';
      io.stderr.write(JSON.stringify({ code, message: err.message, line: i + 1 }) + '\n');
      return 1;
    }
  }

  if (wantStats) {
    const total = pool.subtreeExposure('');
    io.stdout.write(JSON.stringify({ stats: { ...stats, exposure: total.exposure, held: total.held, spent: total.spent } }) + '\n');
  }
  return 0;
}

if (require.main === module) {
  process.exit(run(process.argv.slice(2)));
}

module.exports = { run };
