#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const { run } = require('./lib/engine');

function usage() {
  return 'usage: node cli.js ops.json --limit <n> --max <n> [--window <n>] [--pretty]';
}

function parseArgs(argv) {
  const args = { file: null, limit: undefined, max: undefined, window: undefined, pretty: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--limit' || a === '--max' || a === '--window') {
      const v = Number(argv[i + 1]);
      if (argv[i + 1] === undefined || !Number.isFinite(v)) {
        throw new Error(`missing/invalid value for ${a}`);
      }
      args[a.slice(2)] = v;
      i += 1;
    } else if (a === '--pretty') {
      args.pretty = true;
    } else if (a.startsWith('--')) {
      throw new Error(`unknown flag ${a}`);
    } else if (args.file === null) {
      args.file = a;
    } else {
      throw new Error(`unexpected argument ${a}`);
    }
  }
  return args;
}

// runCli(argv, io) -> exit code. io: { stdout(s), stderr(s) }.
function runCli(argv, io) {
  let args;
  try {
    args = parseArgs(argv);
    if (!args.file || args.limit === undefined || args.max === undefined) {
      throw new Error('ops.json, --limit and --max are required');
    }
  } catch (err) {
    io.stderr(`${usage()}\nerror: ${err.message}\n`);
    return 2;
  }

  let data;
  try {
    data = JSON.parse(fs.readFileSync(args.file, 'utf8'));
  } catch (err) {
    io.stderr(`error: cannot read/parse ${args.file}: ${err.message}\n`);
    return 2;
  }
  const ops = Array.isArray(data) ? data : data.ops;
  if (!Array.isArray(ops)) {
    io.stderr('error: ops.json must be an array or an object with an "ops" array\n');
    return 2;
  }

  const result = run(ops, { limit: args.limit, max: args.max, window: args.window });
  io.stdout(`${JSON.stringify(result, null, args.pretty ? 2 : 0)}\n`);
  return result.exitCode;
}

if (require.main === module) {
  const code = runCli(process.argv.slice(2), {
    stdout: (s) => process.stdout.write(s),
    stderr: (s) => process.stderr.write(s),
  });
  process.exitCode = code;
}

module.exports = { runCli };
