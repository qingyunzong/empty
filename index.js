#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const { mergeRules, ValidationError } = require('./merge');

const USAGE = [
  'Usage:',
  '  node index.js merge-rules --domain d.json --base b.json --local l.json --remote r.json --out result.json',
  '',
  'Exit codes: 0 = merged cleanly, 1 = conflicts, 2 = invalid rules or domain',
].join('\n');

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        throw new Error(`missing value for --${key}`);
      }
      args[key] = next;
      i += 1;
    } else {
      args._.push(token);
    }
  }
  return args;
}

function readJson(path, label) {
  let text;
  try {
    text = fs.readFileSync(path, 'utf8');
  } catch (err) {
    throw new Error(`cannot read ${label} file ${path}: ${err.message}`);
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`invalid JSON in ${label} file ${path}: ${err.message}`);
  }
}

function main(argv, io = { stdout: process.stdout, stderr: process.stderr }) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    io.stderr.write(`${err.message}\n${USAGE}\n`);
    return 2;
  }
  const command = args._[0];
  if (command !== 'merge-rules') {
    io.stderr.write(`${USAGE}\n`);
    return 2;
  }
  for (const flag of ['domain', 'base', 'local', 'remote', 'out']) {
    if (args[flag] === undefined) {
      io.stderr.write(`missing required --${flag} argument\n${USAGE}\n`);
      return 2;
    }
  }

  let inputs;
  try {
    inputs = {
      domain: readJson(args.domain, 'domain'),
      base: readJson(args.base, 'base'),
      local: readJson(args.local, 'local'),
      remote: readJson(args.remote, 'remote'),
    };
  } catch (err) {
    io.stderr.write(`${err.message}\n`);
    return 2;
  }

  let result;
  try {
    result = mergeRules(inputs);
  } catch (err) {
    if (err instanceof ValidationError) {
      io.stderr.write(`invalid input: ${err.message}\n`);
      return 2;
    }
    throw err;
  }

  fs.writeFileSync(args.out, `${JSON.stringify(result, null, 2)}\n`);
  if (result.status === 'conflict') {
    io.stderr.write(`merge completed with ${result.conflicts.length} conflict(s); see ${args.out}\n`);
    return 1;
  }
  io.stdout.write(`merged ${result.rules.length} rule(s), ${result.decisions.length} feature decision(s) -> ${args.out}\n`);
  return 0;
}

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}

module.exports = { main, parseArgs };
