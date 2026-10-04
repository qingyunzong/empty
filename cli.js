#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const { FrameParser } = require('./lib/framing');
const { Engine } = require('./lib/engine');
const { Wal } = require('./lib/wal');
const { linearize } = require('./lib/linearize');

const EXIT_OK = 0;
const EXIT_FRAME_ERROR = 2;
const EXIT_STATE_CONFLICT = 3;
const EXIT_USAGE = 64;
const EXIT_IO = 1;

const USAGE =
  'usage: node cli.js <ops.jsonl> [--limit N] [--ttl MS] [--wal PATH] [--chunk N]';

function parseArgs(argv) {
  const args = { limit: 1000, ttl: 30000, wal: null, chunk: 7, file: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--limit') args.limit = Number(argv[++i]);
    else if (a === '--ttl') args.ttl = Number(argv[++i]);
    else if (a === '--wal') args.wal = argv[++i];
    else if (a === '--chunk') args.chunk = Number(argv[++i]);
    else if (a.startsWith('--')) return null;
    else if (args.file === null) args.file = a;
    else return null;
  }
  if (args.file === null) return null;
  if (!Number.isFinite(args.limit) || args.limit <= 0) return null;
  if (!Number.isFinite(args.ttl) || args.ttl <= 0) return null;
  if (args.wal === null) args.wal = args.file + '.wal';
  return args;
}

// Runs the CLI. Returns the process exit code. io provides stdout/stderr
// sinks so the logic is testable in-process.
function run(argv, io) {
  const args = parseArgs(argv);
  if (args === null) {
    io.stderr(USAGE + '\n');
    return EXIT_USAGE;
  }

  let input;
  try {
    input = fs.readFileSync(args.file, 'utf8');
  } catch (err) {
    io.stderr(JSON.stringify({ error: `cannot read ${args.file}: ${err.message}`, code: 'IO_ERROR' }) + '\n');
    return EXIT_IO;
  }

  // Feed the byte stream through the frame parser in small chunks so sticky
  // and half packets take the same code path as a real connection.
  const parser = new FrameParser();
  const frames = [];
  try {
    for (let i = 0; i < input.length; i += args.chunk) {
      frames.push(...parser.push(input.slice(i, i + args.chunk)));
    }
    frames.push(...parser.end());
  } catch (err) {
    io.stderr(JSON.stringify({ error: err.message, code: err.code || 'INTERNAL' }) + '\n');
    return err.code === 'FRAME_ERROR' ? EXIT_FRAME_ERROR : EXIT_IO;
  }

  const wal = new Wal(args.wal);
  const engine = new Engine({ creditLimit: args.limit, authTtlMs: args.ttl, wal });
  const responses = [];
  try {
    for (const frame of frames) responses.push(engine.apply(frame));
  } catch (err) {
    wal.close();
    io.stderr(JSON.stringify({ error: err.message, code: err.code || 'INTERNAL' }) + '\n');
    if (err.code === 'FRAME_ERROR') return EXIT_FRAME_ERROR;
    if (err.code === 'STATE_CONFLICT') return EXIT_STATE_CONFLICT;
    return EXIT_IO;
  }
  wal.close();

  const out = {
    creditLimit: engine.creditLimit,
    available: engine.available,
    ledger: engine.ledger,
    responses,
    certificate: linearize(engine.ledger),
  };
  io.stdout(JSON.stringify(out, null, 2) + '\n');
  return EXIT_OK;
}

if (require.main === module) {
  const code = run(process.argv.slice(2), {
    stdout: (s) => process.stdout.write(s),
    stderr: (s) => process.stderr.write(s),
  });
  process.exit(code);
}

module.exports = { run, EXIT_OK, EXIT_FRAME_ERROR, EXIT_STATE_CONFLICT };
