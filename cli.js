#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const {
  InputError,
  ConservationError,
  parseJsonl,
  run,
} = require('./lib');

function usage() {
  return 'usage: node cli.js <events.jsonl> [--now <ms>] [--deadline <ms>]';
}

function parseArgs(argv) {
  const args = { file: null, now: 0, deadline: 1000 };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--now' || a === '--deadline') {
      const v = argv[i + 1];
      if (v === undefined || !/^-?\d+(\.\d+)?$/.test(v)) {
        throw new InputError(`invalid value for ${a}: ${v}`);
      }
      args[a.slice(2)] = Number(v);
      i += 1;
    } else if (a === '--help' || a === '-h') {
      console.log(usage());
      process.exit(0);
    } else if (a.startsWith('--')) {
      throw new InputError(`unknown option: ${a}`);
    } else if (args.file === null) {
      args.file = a;
    } else {
      throw new InputError(`unexpected argument: ${a}`);
    }
  }
  if (args.file === null) throw new InputError('missing input file');
  return args;
}

// Executes the CLI purely in-process: returns { code, stdout, stderr }.
// The bin wrapper below maps this onto real streams and process.exit.
function execute(argv, { readFile } = {}) {
  const read = readFile || ((f) => fs.readFileSync(f, 'utf8'));
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    return { code: 2, stdout: '', stderr: `error: ${err.message}\n${usage()}\n` };
  }

  let text;
  try {
    text = read(args.file);
  } catch (err) {
    return { code: 2, stdout: '', stderr: `error: cannot read ${args.file}: ${err.message}\n` };
  }

  let events;
  try {
    events = parseJsonl(text);
  } catch (err) {
    if (err instanceof InputError) {
      return { code: 2, stdout: '', stderr: `error: ${err.message}\n` };
    }
    throw err;
  }

  try {
    const report = run(events, { now: args.now, deadline: args.deadline });
    return { code: 0, stdout: JSON.stringify(report, null, 2) + '\n', stderr: '' };
  } catch (err) {
    if (err instanceof ConservationError) {
      return { code: 4, stdout: '', stderr: `conservation violation: ${err.message}\n` };
    }
    if (err instanceof InputError) {
      return { code: 2, stdout: '', stderr: `error: ${err.message}\n` };
    }
    throw err;
  }
}

if (require.main === module) {
  const { code, stdout, stderr } = execute(process.argv.slice(2));
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
  process.exit(code);
}

module.exports = { execute, parseArgs, usage };
