#!/usr/bin/env node
'use strict';
const evlog = require('./lib/evlog');

const USAGE = 'usage: node cli.js <append|commit|recover|verify|tail> <logfile> [payload...|n]\n';

/* run(argv, io) -> exit code; io defaults to process streams. */
function run(argv, io = { stdout: (s) => process.stdout.write(s), stderr: (s) => process.stderr.write(s) }) {
  const [, , cmd, log, ...rest] = argv;
  if (!cmd || !log) {
    io.stderr(USAGE);
    return 2;
  }
  try {
    switch (cmd) {
      case 'append': {
        if (rest.length === 0) {
          io.stderr(USAGE);
          return 2;
        }
        const h = evlog.open(log);
        const seq = evlog.append(h, rest.join(' '));
        io.stdout(JSON.stringify({ ok: true, seq }) + '\n');
        return 0;
      }
      case 'commit': {
        const h = evlog.open(log);
        io.stdout(JSON.stringify({ ok: true, ...evlog.commit(h) }) + '\n');
        return 0;
      }
      case 'recover':
        io.stdout(JSON.stringify({ ok: true, ...evlog.recover(log) }) + '\n');
        return 0;
      case 'verify':
        io.stdout(JSON.stringify(evlog.verify(log)) + '\n');
        return 0;
      case 'tail': {
        const n = rest.length ? Number.parseInt(rest[0], 10) : 10;
        io.stdout(JSON.stringify({ ok: true, entries: evlog.tail(log, Number.isNaN(n) ? 10 : n) }) + '\n');
        return 0;
      }
      default:
        io.stderr(USAGE);
        return 2;
    }
  } catch (e) {
    const code = e && e.code ? e.code : 'ERR_INTERNAL';
    io.stderr(JSON.stringify({ error: code, message: String(e && e.message) }) + '\n');
    return 1;
  }
}

if (require.main === module) {
  process.exit(run(process.argv));
}

module.exports = { run };
