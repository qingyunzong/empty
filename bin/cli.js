#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { mergeTexts, toJsonl, MergeInputError } = require('../lib/merge');

const USAGE = [
  'Usage: clearing-merge merge <base.jsonl> <left.jsonl> <right.jsonl> \\',
  '         --out result.jsonl --conflicts conflicts.json',
  '',
  'Three-way merge of clearing settlement batches.',
  'Exit codes: 0 ok, 2 input/usage error.',
].join('\n');

function fail(code, line, msg) {
  fs.writeSync(2, `${JSON.stringify({ code, line, msg })}\n`);
  return 2;
}

function parseArgs(argv) {
  if (argv.length === 0 || argv[0] !== 'merge') return null;
  const positional = [];
  const flags = {};
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--out' || arg === '--conflicts') {
      if (i + 1 >= argv.length) return null;
      flags[arg.slice(2)] = argv[i + 1];
      i += 1;
    } else if (arg.startsWith('--')) {
      return null;
    } else {
      positional.push(arg);
    }
  }
  if (positional.length !== 3) return null;
  return { base: positional[0], left: positional[1], right: positional[2], ...flags };
}

function readFileOrExit(filePath, label) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new MergeInputError('READ_ERROR', 0, `cannot read ${label} file ${filePath}: ${err.message}`);
  }
}

function main(argv) {
  const args = parseArgs(argv);
  if (!args) {
    fs.writeSync(2, `${USAGE}\n`);
    return 2;
  }
  try {
    const baseText = readFileOrExit(args.base, 'base');
    const leftText = readFileOrExit(args.left, 'left');
    const rightText = readFileOrExit(args.right, 'right');
    const { records, conflicts } = mergeTexts(baseText, leftText, rightText, {
      base: path.basename(args.base),
      left: path.basename(args.left),
      right: path.basename(args.right),
    });
    if (args.out) {
      fs.writeFileSync(args.out, toJsonl(records));
    } else {
      process.stdout.write(toJsonl(records));
    }
    if (args.conflicts) {
      fs.writeFileSync(args.conflicts, `${JSON.stringify(conflicts, null, 2)}\n`);
    }
    fs.writeSync(2, `merged: ${records.length} record(s), ${conflicts.length} conflict(s)\n`);
    return 0;
  } catch (err) {
    if (err instanceof MergeInputError) {
      return fail(err.code, err.line, err.message);
    }
    throw err;
  }
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}

module.exports = { main, parseArgs };
