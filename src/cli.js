'use strict';

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { runStream } from './machine.js';

export const USAGE = `Usage: node cli.js run --stream <stream.jsonl> --out <dir>

Reads the event stream, writes <dir>/state.json, <dir>/moves.jsonl and
<dir>/errors.jsonl. Exit code 2 when any error was recorded (legal events
are still processed); 0 on a clean run; 1 on usage/IO failure.`;

export function parseArgs(argv) {
  if (argv.length === 0 || argv[0] !== 'run') return null;
  const opts = {};
  for (let i = 1; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === '--stream' || key === '--out') {
      if (i + 1 >= argv.length) return null;
      opts[key.slice(2)] = argv[i + 1];
      i += 1;
    } else {
      return null;
    }
  }
  if (!opts.stream || !opts.out) return null;
  return opts;
}

// Returns the exit code; `log`/`error` default to console.
export function runCli(argv, { log = console.log, error = console.error } = {}) {
  const opts = parseArgs(argv);
  if (!opts) {
    error(USAGE);
    return 1;
  }

  let text;
  try {
    text = readFileSync(opts.stream, 'utf8');
  } catch (err) {
    error(`cannot read stream file: ${err.message}`);
    return 1;
  }

  const machine = runStream(text);

  try {
    mkdirSync(opts.out, { recursive: true });
    writeFileSync(join(opts.out, 'state.json'), `${JSON.stringify(machine.state(), null, 2)}\n`);
    writeFileSync(join(opts.out, 'moves.jsonl'),
      machine.moves.map((m) => JSON.stringify(m)).join('\n') + (machine.moves.length ? '\n' : ''));
    writeFileSync(join(opts.out, 'errors.jsonl'),
      machine.errors.map((e) => JSON.stringify(e)).join('\n') + (machine.errors.length ? '\n' : ''));
  } catch (err) {
    error(`cannot write output: ${err.message}`);
    return 1;
  }

  const s = machine.state();
  log(`good=${s.good} defective=${s.defective} rework=${s.rework} `
    + `running=${s.running} pending=${s.pending.length} `
    + `moves=${machine.moves.length} errors=${machine.errors.length}`);
  return machine.errors.length > 0 ? 2 : 0;
}
