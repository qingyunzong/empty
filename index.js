#!/usr/bin/env node
'use strict';

const fs = require('node:fs');

const { loadRepo, squash, merge, ValidationError } = require('./lib/repo');

function writeOut(text) {
  fs.writeSync(1, text);
}

function writeErr(text) {
  fs.writeSync(2, text);
}

function parseFlags(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (!key.startsWith('--')) {
      throw new ValidationError(`unexpected argument: ${key}`);
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new ValidationError(`missing value for ${key}`);
    }
    flags[key.slice(2)] = value;
    i++;
  }
  return flags;
}

function requireFlags(flags, ...names) {
  for (const name of names) {
    if (flags[name] === undefined) {
      throw new ValidationError(`missing required flag --${name}`);
    }
  }
}

const USAGE = [
  'usage:',
  '  node index.js squash --repo r.json --from <hash> --to <hash> --out n.json',
  '  node index.js merge  --repo r.json --base <hash> --left <hash> --right <hash> --out n.json',
  'exit codes: 0 success, 1 conflict, 2 path/range/validation error',
].join('\n');

function main(argv) {
  const [command, ...rest] = argv;
  if (command === undefined || command === 'help' || command === '--help') {
    writeOut(USAGE + '\n');
    return command === undefined ? 2 : 0;
  }
  const flags = parseFlags(rest);
  if (command === 'squash') {
    requireFlags(flags, 'repo', 'from', 'to', 'out');
    const repo = loadRepo(flags.repo);
    const { repo: out, squashedHash } = squash(repo, flags.from, flags.to);
    fs.writeFileSync(flags.out, JSON.stringify(out, null, 2) + '\n');
    writeOut(`squashed ${flags.from}..${flags.to} into ${squashedHash}\n`);
    return 0;
  }
  if (command === 'merge') {
    requireFlags(flags, 'repo', 'base', 'left', 'right', 'out');
    const repo = loadRepo(flags.repo);
    const { repo: out, mergeHash } = merge(repo, flags.base, flags.left, flags.right);
    fs.writeFileSync(flags.out, JSON.stringify(out, null, 2) + '\n');
    writeOut(`merged into ${mergeHash}\n`);
    return 0;
  }
  throw new ValidationError(`unknown command: ${command}\n${USAGE}`);
}

if (require.main === module) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    if (err && err.code === 'CONFLICT') {
      writeErr('conflict:\n' + err.conflicts.map((c) => `  - ${c.detail}`).join('\n') + '\n');
      process.exitCode = 1;
    } else if (err && (err.code === 'PATH' || err.code === 'RANGE' ||
        err.code === 'VALIDATION' || err.code === 'PATCH_SEQUENCE')) {
      writeErr(`error: ${err.message}\n`);
      process.exitCode = 2;
    } else {
      writeErr(`error: ${(err && err.stack) || err}\n`);
      process.exitCode = 2;
    }
  }
}

module.exports = { main };
