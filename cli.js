#!/usr/bin/env node
'use strict';

const { Log, LogError } = require('./lib');

const USAGE =
  [
    'usage:',
    '  node cli.js append <log> <id> <ts> <value> [quality]',
    '  node cli.js flag <log> <id> <quality> [ts]',
    '  node cli.js invalidate <log> <id> [ts]',
    '  node cli.js current <log> <id>',
    '  node cli.js history <log> <id>',
    '  node cli.js verify <log>',
    '',
  ].join('\n');

function parseValue(s) {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

function run(argv, stdout, stderr) {
  const [, , cmd, logPath, ...args] = argv;
  if (!cmd || !logPath) {
    stderr.write(USAGE);
    return 2;
  }
  const log = new Log(logPath);
  const out = (obj) => stdout.write(JSON.stringify(obj) + '\n');
  switch (cmd) {
    case 'append': {
      const [id, ts, value, quality] = args;
      if (id === undefined || ts === undefined || value === undefined) {
        stderr.write(USAGE);
        return 2;
      }
      out(log.appendObs(id, Number(ts), parseValue(value), quality));
      return 0;
    }
    case 'flag': {
      const [id, quality, ts] = args;
      if (id === undefined || quality === undefined) {
        stderr.write(USAGE);
        return 2;
      }
      out(log.flag(id, quality, ts === undefined ? undefined : Number(ts)));
      return 0;
    }
    case 'invalidate': {
      const [id, ts] = args;
      if (id === undefined) {
        stderr.write(USAGE);
        return 2;
      }
      out(log.invalidate(id, ts === undefined ? undefined : Number(ts)));
      return 0;
    }
    case 'current': {
      const [id] = args;
      if (id === undefined) {
        stderr.write(USAGE);
        return 2;
      }
      out(log.current(id));
      return 0;
    }
    case 'history': {
      const [id] = args;
      if (id === undefined) {
        stderr.write(USAGE);
        return 2;
      }
      out(log.history(id));
      return 0;
    }
    case 'verify': {
      out(log.verify());
      return 0;
    }
    default:
      stderr.write(USAGE);
      return 2;
  }
}

function main() {
  try {
    const code = run(process.argv, process.stdout, process.stderr);
    process.exit(code);
  } catch (err) {
    const code = err instanceof LogError ? err.code : 'ERR_INTERNAL';
    process.stderr.write(JSON.stringify({ error: code }) + '\n');
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { run };
