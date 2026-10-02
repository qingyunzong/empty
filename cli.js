#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runStream } from './src/run.js';

function usage() {
  console.error('usage: node cli.js run --stream <stream.jsonl> --out <dir>');
}

function parseArgs(argv) {
  if (argv[0] !== 'run') return null;
  const opts = {};
  for (let i = 1; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === '--stream' || key === '--out') {
      const value = argv[i + 1];
      if (value === undefined) return null;
      opts[key.slice(2)] = value;
      i += 1;
    } else {
      return null;
    }
  }
  if (!opts.stream || !opts.out) return null;
  return opts;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts) {
    usage();
    process.exitCode = 1;
    return;
  }

  let text;
  try {
    text = readFileSync(opts.stream, 'utf8');
  } catch (err) {
    console.error(`cannot read stream file: ${err.message}`);
    process.exitCode = 1;
    return;
  }

  const { state, moves, errors } = runStream(text);

  mkdirSync(opts.out, { recursive: true });
  writeFileSync(join(opts.out, 'state.json'), `${JSON.stringify(state, null, 2)}\n`);
  writeFileSync(
    join(opts.out, 'moves.jsonl'),
    moves.map((m) => JSON.stringify(m)).join('\n') + (moves.length ? '\n' : ''),
  );
  writeFileSync(
    join(opts.out, 'errors.jsonl'),
    errors.map((e) => JSON.stringify(e)).join('\n') + (errors.length ? '\n' : ''),
  );

  console.log(
    `state: good=${state.good} defective=${state.defective} rework=${state.rework} pending=${state.pending}`,
  );
  console.log(`moves: ${moves.length}, errors: ${errors.length}`);
  if (errors.length > 0) {
    process.exitCode = 2;
  }
}

main();
