#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const {
  Ledger,
  ConflictError,
  SealedError,
  ArgumentError,
  normalizePatches,
} = require('./ledger');

const USAGE = 'usage: node index.js rewrite --book <book.json> --seq <n> --patch <patch.json> --out <out.json>';

function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!command) throw new ArgumentError(USAGE);
  const opts = {};
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    if (!token.startsWith('--')) throw new ArgumentError(`unexpected argument: ${token}\n${USAGE}`);
    const key = token.slice(2);
    const value = rest[i + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new ArgumentError(`missing value for --${key}\n${USAGE}`);
    }
    opts[key] = value;
    i += 1;
  }
  return { command, opts };
}

function readJson(path, label) {
  let text;
  try {
    text = fs.readFileSync(path, 'utf8');
  } catch (err) {
    throw new ArgumentError(`cannot read ${label} file ${path}: ${err.message}`);
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new ArgumentError(`invalid JSON in ${label} file ${path}: ${err.message}`);
  }
}

function cmdRewrite(opts) {
  const { book, seq, patch, out } = opts;
  if (!book || !seq || !patch || !out) throw new ArgumentError(USAGE);
  const seqNum = Number(seq);
  if (!Number.isInteger(seqNum)) throw new ArgumentError(`--seq must be an integer, got ${seq}`);

  const ledger = Ledger.fromJSON(readJson(book, 'book'));
  const patches = normalizePatches(readJson(patch, 'patch'));

  const { hashMap } = ledger.rewrite(seqNum, patches);

  fs.writeFileSync(out, JSON.stringify(ledger.toJSON(), null, 2) + '\n');
  process.stdout.write(JSON.stringify({ hashMap }, null, 2) + '\n');
  return 0;
}

function main(argv) {
  const { command, opts } = parseArgs(argv);
  switch (command) {
    case 'rewrite':
      return cmdRewrite(opts);
    default:
      throw new ArgumentError(`unknown command: ${command}\n${USAGE}`);
  }
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (err) {
  if (err instanceof ConflictError) {
    process.stderr.write(`conflict: ${err.message}\n${JSON.stringify(err.details)}\n`);
    process.exitCode = 1;
  } else if (err instanceof SealedError || err instanceof ArgumentError) {
    process.stderr.write(`error: ${err.message}\n`);
    process.exitCode = 2;
  } else {
    process.stderr.write(`error: ${err && err.message ? err.message : String(err)}\n`);
    process.exitCode = 2;
  }
}
