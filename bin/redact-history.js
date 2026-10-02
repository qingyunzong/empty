#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const { rewriteHistory, AbortRewrite } = require('../src/redact');

const USAGE = [
  'usage: redact-history rewrite --repo <repo.json> --rules <rules.json>',
  '                              --out <rewritten.json> --proof <proof.json>',
  '                              [--token-length <n>]',
  '',
  'exit codes: 0 success, 1 usage/io error, 2 rewrite aborted (token collision,',
  'unlocatable patch context, or projection mismatch); on abort nothing is written.',
].join('\n');

function parseArgs(argv) {
  const args = { tokenLength: 12 };
  const rest = [...argv];
  if (rest[0] === 'rewrite') rest.shift();
  while (rest.length > 0) {
    const flag = rest.shift();
    const value = rest.shift();
    if (value === undefined) throw new Error('missing value for ' + flag);
    switch (flag) {
      case '--repo': args.repo = value; break;
      case '--rules': args.rules = value; break;
      case '--out': args.out = value; break;
      case '--proof': args.proof = value; break;
      case '--token-length':
        args.tokenLength = Number(value);
        if (!Number.isInteger(args.tokenLength) || args.tokenLength < 1 || args.tokenLength > 64) {
          throw new Error('--token-length must be an integer in [1, 64]');
        }
        break;
      default: throw new Error('unknown flag: ' + flag);
    }
  }
  for (const key of ['repo', 'rules', 'out', 'proof']) {
    if (!args[key]) throw new Error('missing required flag --' + key);
  }
  return args;
}

function main(argv, io = { log: console.log, error: console.error }) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    io.error(err.message);
    io.error(USAGE);
    return 1;
  }

  let repo;
  let rules;
  try {
    repo = JSON.parse(fs.readFileSync(args.repo, 'utf8'));
    const rulesDoc = JSON.parse(fs.readFileSync(args.rules, 'utf8'));
    rules = Array.isArray(rulesDoc) ? rulesDoc : rulesDoc.rules;
    if (!Array.isArray(rules)) throw new Error('rules file must be an array or { "rules": [...] }');
  } catch (err) {
    io.error('failed to read input: ' + err.message);
    return 1;
  }

  let result;
  try {
    result = rewriteHistory(repo, rules, { tokenLength: args.tokenLength });
  } catch (err) {
    if (err instanceof AbortRewrite) {
      io.error('abort (' + err.reason + '): ' + err.message);
      return 2;
    }
    throw err;
  }

  fs.writeFileSync(args.out, JSON.stringify(result.repo, null, 2) + '\n');
  fs.writeFileSync(args.proof, JSON.stringify(result.proof, null, 2) + '\n');
  io.log(
    'rewrote ' + result.proof.commitMap.length + ' commit(s), ' +
    result.proof.redactedValueCount + ' sensitive value(s); head ' +
    (result.proof.oldHead || '(none)') + ' -> ' + (result.proof.newHead || '(none)'));
  return 0;
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}

module.exports = { main, parseArgs, USAGE };
