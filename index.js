#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const { normalizeGraph, mergeGraphs, GraphFormatError } = require('./lib/genealogy');

const USAGE = [
  'usage:',
  '  node index.js merge-genealogy --base <base.json> --local <local.json> --remote <remote.json> --out <result.json>',
  '',
  'exit codes: 0 = clean merge, 1 = conflicts, 2 = input JSON / reference format error',
].join('\n');

class CliError extends Error {}

function fail(message) {
  throw new CliError(message);
}

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) fail(`unexpected argument: ${arg}`);
    const key = arg.slice(2);
    if (!['base', 'local', 'remote', 'out'].includes(key)) fail(`unknown option: --${key}`);
    const value = argv[i + 1];
    if (value === undefined) fail(`missing value for --${key}`);
    opts[key] = value;
    i += 1;
  }
  return opts;
}

function loadGraph(path, label) {
  let text;
  try {
    text = fs.readFileSync(path, 'utf8');
  } catch (err) {
    fail(`cannot read ${label} file ${path}: ${err.message}`);
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    fail(`invalid JSON in ${label} file ${path}: ${err.message}`);
  }
  try {
    return normalizeGraph(raw, label);
  } catch (err) {
    if (err instanceof GraphFormatError) fail(err.message);
    throw err;
  }
}

function main(argv) {
  const [command, ...rest] = argv;
  if (command !== 'merge-genealogy') {
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }
  try {
    const opts = parseArgs(rest);
    for (const key of ['base', 'local', 'remote', 'out']) {
      if (!opts[key]) fail(`missing required option --${key}`);
    }
    const base = loadGraph(opts.base, 'base');
    const local = loadGraph(opts.local, 'local');
    const remote = loadGraph(opts.remote, 'remote');

    const result = mergeGraphs(base, local, remote);
    fs.writeFileSync(opts.out, `${JSON.stringify(result, null, 2)}\n`);

    if (result.conflicts.length > 0) {
      console.error(`merge finished with ${result.conflicts.length} conflict(s); result written to ${opts.out}`);
      process.exitCode = 1;
      return;
    }
    console.log(`clean merge; result written to ${opts.out}`);
  } catch (err) {
    if (err instanceof CliError) {
      console.error(`error: ${err.message}`);
      process.exitCode = 2;
      return;
    }
    throw err;
  }
}

main(process.argv.slice(2));
