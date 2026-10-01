#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const { Pool, PoolError } = require('./pool.js');

// Returns an exit code; io provides stdout/stderr write functions.
function runCli(argv, io) {
  const [command, ...rest] = argv;
  const usage = 'usage: pool exec <ops.jsonl> [--stats]';
  if (command !== 'exec') {
    io.stderr(JSON.stringify({ code: 'E_USAGE', message: usage }));
    return 1;
  }
  const wantStats = rest.includes('--stats');
  const file = rest.find((a) => a !== '--stats');
  if (!file) {
    io.stderr(JSON.stringify({ code: 'E_USAGE', message: usage }));
    return 1;
  }

  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    io.stderr(JSON.stringify({ code: 'E_IO', message: `cannot read ${file}: ${err.message}` }));
    return 1;
  }

  const pool = new Pool();
  const counters = { add: 0, reserve: 0, commit: 0, abort: 0, exposure: 0, batch: 0 };
  let processed = 0;

  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    let op;
    try {
      op = JSON.parse(line);
    } catch (err) {
      io.stderr(JSON.stringify({ code: 'E_PARSE', message: `line ${i + 1}: invalid JSON: ${err.message}` }));
      return 1;
    }
    try {
      const result = pool.run(op);
      if (counters[op.op] !== undefined) counters[op.op] += 1;
      processed += 1;
      io.stdout(JSON.stringify({ line: i + 1, ok: true, result }));
    } catch (err) {
      if (err instanceof PoolError) {
        io.stderr(JSON.stringify({ code: err.code, message: `line ${i + 1}: ${err.message}` }));
        return 1;
      }
      throw err;
    }
  }

  if (wantStats) {
    let activeHolds = 0;
    for (const hold of pool.holds.values()) if (hold.state === 'active') activeHolds += 1;
    const root = pool.root
      ? pool.subtreeExposure([pool.root.name])
      : { held: 0, spent: 0, exposure: 0 };
    io.stdout(
      JSON.stringify({
        stats: {
          processed,
          ...counters,
          activeHolds,
          root: { limit: pool.root ? pool.root.limit : 0, ...root },
        },
      })
    );
  }
  return 0;
}

if (require.main === module) {
  const code = runCli(process.argv.slice(2), {
    stdout: (s) => process.stdout.write(s + '\n'),
    stderr: (s) => process.stderr.write(s + '\n'),
  });
  process.exit(code);
}

module.exports = { runCli };
