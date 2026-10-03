#!/usr/bin/env node
'use strict';

const { open, recover, verify, tail } = require('./lib/evlog');

const USAGE = 'usage: node cli.js <append|commit|recover|verify|tail> <log> [payload...|n]';

function usageError() {
  const err = new Error(USAGE);
  err.code = 'ERR_USAGE';
  return err;
}

function dispatch(argv) {
  const [cmd, log, ...rest] = argv;
  if (!cmd || !log) throw usageError();
  switch (cmd) {
    case 'append': {
      if (rest.length === 0) throw usageError();
      const seq = open(log).append(rest.join(' '));
      return { ok: true, seq };
    }
    case 'commit':
      return { ok: true, ...open(log).commit() };
    case 'recover':
      return { ok: true, ...recover(log) };
    case 'verify':
      return verify(log);
    case 'tail': {
      let n;
      if (rest[0] !== undefined) {
        n = Number(rest[0]);
        if (!Number.isInteger(n) || n < 0) throw usageError();
      }
      return { ok: true, entries: tail(log, n) };
    }
    default:
      throw usageError();
  }
}

// Runs one CLI invocation. Returns { code, stdout, stderr } without touching
// process stdio, so tests can drive the CLI in-process.
function run(argv) {
  try {
    const result = dispatch(argv);
    return { code: 0, stdout: `${JSON.stringify(result)}\n`, stderr: '' };
  } catch (err) {
    const code = err && err.code ? err.code : 'ERR_INTERNAL';
    const message = err && err.message ? err.message : String(err);
    return { code: 1, stdout: '', stderr: `${JSON.stringify({ error: code, message })}\n` };
  }
}

if (require.main === module) {
  const { code, stdout, stderr } = run(process.argv.slice(2));
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
  process.exit(code);
}

module.exports = { run };
