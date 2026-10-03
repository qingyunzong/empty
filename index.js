#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const { applyPatch, PatchError } = require('./lib/patch');
const { mergePatches, MergeConflict } = require('./lib/merge');
const { loadHistory, squash, RangeError2 } = require('./lib/history');

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const flags = {};
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = rest[index + 1];
      if (next === undefined || next.startsWith('--')) {
        flags[key] = true;
      } else {
        flags[key] = next;
        index += 1;
      }
    }
  }
  return { command, flags };
}

function readJson(path) {
  return JSON.parse(fs.readFileSync(path, 'utf8'));
}

function writeJson(path, value) {
  fs.writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
}

function fail(code, message) {
  fs.writeSync(2, message + '\n');
  process.exit(code);
}

function cmdSquash(flags) {
  if (!flags.repo || !flags.from || !flags.to || !flags.out) {
    fail(2, 'usage: node index.js squash --repo r.json --from h --to h --out n.json');
  }
  let repo;
  try {
    repo = readJson(flags.repo);
  } catch (error) {
    fail(2, `cannot read repo: ${error.message}`);
  }
  try {
    const result = squash(repo, flags.from, flags.to);
    writeJson(flags.out, result.repo);
    process.stdout.write(`squashed into ${result.squashedHash}\n`);
  } catch (error) {
    if (error instanceof RangeError2 || error instanceof PatchError) fail(2, error.message);
    throw error;
  }
}

function cmdMerge(flags) {
  if (!flags.repo || !flags.base || !flags.left || !flags.right || !flags.out) {
    fail(2, 'usage: node index.js merge --repo r.json --base h --left lp.json --right rp.json --out n.json');
  }
  let repo;
  try {
    repo = readJson(flags.repo);
  } catch (error) {
    fail(2, `cannot read repo: ${error.message}`);
  }
  let leftPatch;
  let rightPatch;
  try {
    leftPatch = readJson(flags.left);
    rightPatch = readJson(flags.right);
  } catch (error) {
    fail(2, `cannot read patch: ${error.message}`);
  }
  let history;
  try {
    history = loadHistory(repo);
  } catch (error) {
    if (error instanceof PatchError) fail(2, error.message);
    throw error;
  }
  const baseIndex = history.commits.findIndex((commit) => commit.hash === flags.base);
  if (baseIndex === -1) fail(2, `unknown --base commit "${flags.base}"`);
  let baseState = history.base;
  for (let i = 0; i <= baseIndex; i += 1) baseState = applyPatch(baseState, history.commits[i].patch);
  try {
    const merged = mergePatches(leftPatch, rightPatch);
    const tree = applyPatch(baseState, merged);
    writeJson(flags.out, { patch: merged, tree });
    process.stdout.write('merged cleanly\n');
  } catch (error) {
    if (error instanceof MergeConflict) fail(1, error.message);
    if (error instanceof PatchError) fail(2, error.message);
    throw error;
  }
}

function cmdLog(flags) {
  if (!flags.repo) fail(2, 'usage: node index.js log --repo r.json');
  let history;
  try {
    history = loadHistory(readJson(flags.repo));
  } catch (error) {
    if (error instanceof PatchError) fail(2, error.message);
    throw error;
  }
  for (const commit of history.commits) {
    process.stdout.write(`${commit.hash}${commit.sealed ? ' (sealed)' : ''}\n`);
  }
}

function main() {
  const { command, flags } = parseArgs(process.argv.slice(2));
  if (command === 'squash') return cmdSquash(flags);
  if (command === 'merge') return cmdMerge(flags);
  if (command === 'log') return cmdLog(flags);
  fail(2, 'usage: node index.js <squash|merge|log> [flags]');
}

main();
