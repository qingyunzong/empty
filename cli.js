#!/usr/bin/env node
'use strict';
// Usage:
//   node cli.js project <events.jsonl>             -> projection {accounts:{...}}
//   node cli.js guard <events.jsonl> <event|@file> -> guard verdict (exit 1 on reject)
//   node cli.js cert <events.jsonl>                -> per-account terminal hashes
//
// Also usable in-process: require('./cli').run(argv) -> {code, stdout, stderr}.

const fs = require('node:fs');
const { project, guard, certify } = require('./src/model');

function readLog(file) {
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

function readEvent(arg) {
  if (!arg || arg === '-') {
    return JSON.parse(fs.readFileSync(0, 'utf8'));
  }
  if (arg.startsWith('@')) {
    return JSON.parse(fs.readFileSync(arg.slice(1), 'utf8'));
  }
  return JSON.parse(arg);
}

function run(argv) {
  const [cmd, ...args] = argv;
  switch (cmd) {
    case 'project': {
      const state = project(readLog(args[0]));
      return { code: 0, stdout: JSON.stringify({ accounts: state.accounts }, null, 2) + '\n', stderr: '' };
    }
    case 'guard': {
      const state = project(readLog(args[0]));
      const result = guard(state, readEvent(args[1]));
      return { code: result.ok ? 0 : 1, stdout: JSON.stringify(result, null, 2) + '\n', stderr: '' };
    }
    case 'cert': {
      const state = project(readLog(args[0]));
      return { code: 0, stdout: JSON.stringify(certify(state), null, 2) + '\n', stderr: '' };
    }
    default:
      return { code: 2, stdout: '', stderr: 'usage: node cli.js project|guard|cert ...\n' };
  }
}

module.exports = { run };

if (require.main === module) {
  try {
    const { code, stdout, stderr } = run(process.argv.slice(2));
    if (stdout) process.stdout.write(stdout);
    if (stderr) process.stderr.write(stderr);
    process.exit(code);
  } catch (e) {
    process.stderr.write(`error: ${e.message}\n`);
    process.exit(2);
  }
}
