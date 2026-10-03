#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const {
  validateDomain,
  validateRules,
  mergeAll,
} = require('./lib/merge');

const USAGE = [
  'Usage: node index.js merge-rules --domain <file> --base <file> --local <file> --remote <file> --out <file>',
  '',
  'Exit codes: 0 = merged cleanly, 1 = conflicts, 2 = invalid rules or domain',
].join('\n');

function eprint(message) {
  fs.writeSync(2, `${message}\n`);
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`missing value for --${key}`);
      }
      args[key] = value;
      i += 1;
    } else {
      args._.push(token);
    }
  }
  return args;
}

function readJson(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    throw new Error(`cannot read ${file}: ${error.message}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`invalid JSON in ${file}: ${error.message}`);
  }
}

function normalizeRules(payload, label) {
  if (Array.isArray(payload)) return payload;
  if (typeof payload === 'object' && payload !== null && Array.isArray(payload.rules)) {
    return payload.rules;
  }
  throw new Error(`${label}: expected an array of rules or an object with a "rules" array`);
}

function run(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    eprint(error.message);
    return 2;
  }

  if (args._[0] !== 'merge-rules') {
    eprint(USAGE);
    return args._.length === 0 ? 0 : 2;
  }

  for (const key of ['domain', 'base', 'local', 'remote', 'out']) {
    if (args[key] === undefined) {
      eprint(`missing required option --${key}`);
      return 2;
    }
  }

  let domain;
  let base;
  let local;
  let remote;
  try {
    domain = readJson(args.domain);
    base = normalizeRules(readJson(args.base), 'base');
    local = normalizeRules(readJson(args.local), 'local');
    remote = normalizeRules(readJson(args.remote), 'remote');
  } catch (error) {
    eprint(error.message);
    return 2;
  }

  const errors = [...validateDomain(domain)];
  if (errors.length === 0) {
    errors.push(...validateRules(base, domain, 'base'));
    errors.push(...validateRules(local, domain, 'local'));
    errors.push(...validateRules(remote, domain, 'remote'));
  }
  if (errors.length > 0) {
    eprint(`invalid input:\n${errors.map((e) => `  - ${e}`).join('\n')}`);
    return 2;
  }

  const result = mergeAll(domain, base, local, remote);
  fs.writeFileSync(args.out, `${JSON.stringify(result, null, 2)}\n`);
  return result.conflicts.length > 0 ? 1 : 0;
}

process.exitCode = run(process.argv.slice(2));
