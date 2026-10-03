#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const {
  CycleError,
  createState,
  loadBase,
  applyDeltas,
  rollback,
  serialize,
} = require('./recon');

const USAGE = `usage:
  node cli.js recon --base c.jsonl --deltas d.jsonl [--rollback day:2024-01-01[@version]]... [--out versions.jsonl]`;

function parseJsonl(text, file) {
  return text
    .split('\n')
    .map((line, i) => ({ line: line.trim(), n: i + 1 }))
    .filter((x) => x.line.length > 0)
    .map((x) => {
      try {
        return JSON.parse(x.line);
      } catch (err) {
        throw new Error(`${file}:${x.n}: invalid JSON: ${err.message}`);
      }
    });
}

function parseRollback(spec) {
  const m = /^([A-Za-z]+):([^@]+?)(?:@(\d+))?$/.exec(spec);
  if (!m) throw new Error(`invalid --rollback spec: ${spec} (expected level:target[@version])`);
  return { level: m[1], target: m[2], version: m[3] != null ? Number(m[3]) : null };
}

function main(argv) {
  const args = argv.slice(2);
  const cmd = args.shift();
  if (cmd !== 'recon') {
    console.error(USAGE);
    process.exitCode = cmd === undefined || cmd === '--help' || cmd === '-h' ? 0 : 2;
    return;
  }
  const opts = { base: null, deltas: null, rollbacks: [], out: 'versions.jsonl' };
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--base': opts.base = args[++i]; break;
      case '--deltas': opts.deltas = args[++i]; break;
      case '--rollback': opts.rollbacks.push(args[++i]); break;
      case '--out': opts.out = args[++i]; break;
      default:
        console.error(`unknown option: ${args[i]}\n${USAGE}`);
        process.exitCode = 2;
        return;
    }
  }
  if (!opts.base) {
    console.error(`missing --base\n${USAGE}`);
    process.exitCode = 2;
    return;
  }

  try {
    const state = createState();
    loadBase(state, parseJsonl(fs.readFileSync(opts.base, 'utf8'), opts.base));
    if (opts.deltas) {
      applyDeltas(state, parseJsonl(fs.readFileSync(opts.deltas, 'utf8'), opts.deltas));
    }
    for (const spec of opts.rollbacks) rollback(state, parseRollback(spec));
    fs.writeFileSync(opts.out, serialize(state));
    console.log(`wrote ${state.out.length} records to ${opts.out}`);
  } catch (err) {
    if (err instanceof CycleError || err.code === 'CYCLE') {
      console.error(`error: ${err.message}`);
      process.exitCode = 6;
      return;
    }
    throw err;
  }
}

main(process.argv);
