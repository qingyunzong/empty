#!/usr/bin/env node
'use strict';

// Usage: node cli.js <frames.bin> [--limit N] [--ttl N] [--key K]
// Exit codes: 0 ok | 1 usage/io/invalid | 2 mac | 3 conflict | 4 negative frozen

const fs = require('node:fs');
const { FrameParser } = require('./lib/frame');
const { Engine, EngineError } = require('./lib/engine');

const DEFAULT_KEY = 'hotel-preauth-secret';
const CHUNK = 1024; // feed the parser in slices to exercise stream reassembly

function parseArgs(argv) {
  const opts = { limit: 100000, ttl: 100, key: DEFAULT_KEY, file: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--limit') opts.limit = Number(argv[++i]);
    else if (a === '--ttl') opts.ttl = Number(argv[++i]);
    else if (a === '--key') opts.key = argv[++i];
    else if (a.startsWith('--limit=')) opts.limit = Number(a.slice(8));
    else if (a.startsWith('--ttl=')) opts.ttl = Number(a.slice(6));
    else if (a.startsWith('--key=')) opts.key = a.slice(6);
    else if (!a.startsWith('--') && opts.file === null) opts.file = a;
    else throw new Error(`unknown argument: ${a}`);
  }
  if (opts.file === null) throw new Error('missing <frames.bin>');
  if (!Number.isInteger(opts.limit) || opts.limit <= 0) throw new Error('--limit must be a positive integer');
  if (!Number.isInteger(opts.ttl) || opts.ttl < 0) throw new Error('--ttl must be a non-negative integer');
  return opts;
}

// Invoable in-process: returns { code, stdout, stderr }.
function run(argv, readFile = fs.readFileSync) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    return {
      code: 1,
      stdout: '',
      stderr: `usage: node cli.js <frames.bin> [--limit N] [--ttl N] [--key K]\n${err.message}`,
    };
  }

  let data;
  try {
    data = readFile(opts.file);
  } catch (err) {
    return { code: 1, stdout: '', stderr: `cannot read ${opts.file}: ${err.message}` };
  }

  const engine = new Engine({ limit: opts.limit, ttl: opts.ttl });
  const parser = new FrameParser(opts.key);
  try {
    for (let off = 0; off < data.length; off += CHUNK) {
      for (const record of parser.push(data.subarray(off, off + CHUNK))) {
        engine.ingest(record);
      }
    }
    if (parser.pendingBytes !== 0) {
      throw new EngineError(1, `truncated stream: ${parser.pendingBytes} dangling bytes`);
    }
  } catch (err) {
    if (err instanceof EngineError) {
      return {
        code: err.code,
        stdout: `${JSON.stringify(engine.report(), null, 2)}\n`,
        stderr: `error(exit ${err.code}): ${err.message}`,
      };
    }
    throw err;
  }

  return { code: 0, stdout: `${JSON.stringify(engine.report(), null, 2)}\n`, stderr: '' };
}

if (require.main === module) {
  const { code, stdout, stderr } = run(process.argv.slice(2));
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(`${stderr}\n`);
  process.exit(code);
}

module.exports = { run, parseArgs, DEFAULT_KEY };
