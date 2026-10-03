#!/usr/bin/env node
'use strict';

// Usage: node src/cli.js < req.json
// req.json: { "config": {...}, "state": {...}, "transactions": [{"op": {...}, "budget": N}] }
// Output: JSON with per-transaction results (diffs, recompute queue,
// certificate) and the final derived state.

const { Engine } = require('./engine');

function main() {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    input += chunk;
  });
  process.stdin.on('end', () => {
    let req;
    try {
      req = JSON.parse(input);
    } catch {
      process.stdout.write(JSON.stringify({ ok: false, error: 'E_INPUT' }) + '\n');
      process.exit(1);
    }
    const engine = new Engine(req.config || {}, req.state || {});
    const results = (req.transactions || []).map((tx) => engine.applyTransaction(tx));
    process.stdout.write(
      JSON.stringify(
        {
          ok: true,
          results,
          final: {
            flags: engine.getFlags(),
            summaries: engine.getSummaries(),
            stateHash: engine.stateHash(),
          },
        },
        null,
        2
      ) + '\n'
    );
  });
}

main();
