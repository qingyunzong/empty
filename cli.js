#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const { CorrectionLog, CorrectionError } = require('./src/correction-log');

function usage() {
  return [
    'usage: node cli.js <observations.json> <corrections.json> [options]',
    'options:',
    '  --state <path>      state output path (default: state.json)',
    '  --history <path>    history output path (default: history.json)',
    '  --compact <a:b>     compact contiguous 1-based seq range [a, b] after applying',
  ].join('\n');
}

function parseArgs(argv) {
  const args = { state: 'state.json', history: 'history.json', compact: null, positional: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--state' || arg === '--history' || arg === '--compact') {
      if (i + 1 >= argv.length) throw new CorrectionError('BAD_ARGS', `missing value for ${arg}`);
      const value = argv[i + 1];
      i += 1;
      if (arg === '--state') args.state = value;
      else if (arg === '--history') args.history = value;
      else args.compact = value;
    } else if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else {
      args.positional.push(arg);
    }
  }
  return args;
}

function readJson(path) {
  try {
    return JSON.parse(fs.readFileSync(path, 'utf8'));
  } catch (err) {
    throw new CorrectionError('BAD_INPUT', `cannot read ${path}: ${err.message}`);
  }
}

function main(argv, io) {
  const args = parseArgs(argv);
  if (args.help || args.positional.length !== 2) {
    io.log(usage());
    return args.help ? 0 : 1;
  }
  const [obsPath, corrPath] = args.positional;
  const observations = readJson(obsPath);
  const corrections = readJson(corrPath);
  if (!Array.isArray(corrections)) {
    throw new CorrectionError('BAD_INPUT', 'corrections.json must be an array');
  }

  const log = new CorrectionLog(observations);
  for (const correction of corrections) {
    log.apply(correction);
  }

  if (args.compact !== null) {
    const match = /^(\d+):(\d+)$/.exec(args.compact);
    if (!match) {
      throw new CorrectionError('BAD_ARGS', `--compact expects <start:end>, got ${args.compact}`);
    }
    log.compact(Number(match[1]), Number(match[2]));
  }

  const stateOut = { observations: log.state(), stateHash: log.stateHash() };
  fs.writeFileSync(args.state, JSON.stringify(stateOut, null, 2) + '\n');
  fs.writeFileSync(args.history, JSON.stringify(log.history(), null, 2) + '\n');
  io.log(`wrote ${args.state} and ${args.history} (stateHash=${log.stateHash()})`);
  return 0;
}

function run(argv, io = { log: (m) => console.log(m), error: (m) => console.error(m) }) {
  try {
    return main(argv, io);
  } catch (err) {
    if (err instanceof CorrectionError) {
      io.error(`error [${err.code}]: ${err.message}`);
    } else {
      io.error(`error: ${err.message}`);
    }
    return 1;
  }
}

if (require.main === module) {
  process.exit(run(process.argv.slice(2)));
}

module.exports = { main, run, parseArgs };
