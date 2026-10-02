#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const { AuditLog, AuditError, applyCommand } = require('./auditlog.js');

const USAGE = 'usage: node cli.js <log.jsonl> [--as-of <t>]';

function parseArgs(argv) {
  let file = null;
  let asOf = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--as-of') {
      const raw = argv[++i];
      if (raw === undefined || !/^-?\d+$/.test(raw)) {
        throw new AuditError('E_ARGS', `--as-of requires an integer argument\n${USAGE}`);
      }
      asOf = Number.parseInt(raw, 10);
    } else if (arg.startsWith('--')) {
      throw new AuditError('E_ARGS', `unknown option ${arg}\n${USAGE}`);
    } else if (file === null) {
      file = arg;
    } else {
      throw new AuditError('E_ARGS', `unexpected argument ${arg}\n${USAGE}`);
    }
  }
  if (file === null) {
    throw new AuditError('E_ARGS', `missing log file\n${USAGE}`);
  }
  return { file, asOf };
}

function formatView(view) {
  return JSON.stringify({
    type: 'view',
    asOf: view.asOf,
    visible: view.visible,
    hidden: view.hidden,
    hash: view.hash,
  }) + '\n';
}

function run(argv, writeOut, writeErr) {
  try {
    const { file, asOf } = parseArgs(argv);
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (err) {
      throw new AuditError('E_IO', `cannot read ${file}: ${err.message}`);
    }
    const log = new AuditLog();
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.trim() === '') continue;
      let cmd;
      try {
        cmd = JSON.parse(line);
      } catch (err) {
        throw new AuditError('E_PARSE', `line ${i + 1}: invalid JSON: ${err.message}`);
      }
      let result;
      try {
        result = applyCommand(log, cmd);
      } catch (err) {
        if (err instanceof AuditError) {
          throw new AuditError(err.code, `line ${i + 1}: ${err.message}`);
        }
        throw err;
      }
      if (result && result.view) writeOut(formatView(result.view));
    }
    if (asOf !== null) writeOut(formatView(log.computeView(asOf)));
    return 0;
  } catch (err) {
    if (err instanceof AuditError) {
      writeErr(`error[${err.code}]: ${err.message}\n`);
    } else {
      writeErr(`error[E_INTERNAL]: ${err && err.stack ? err.stack : err}\n`);
    }
    return 1;
  }
}

if (require.main === module) {
  const code = run(
    process.argv.slice(2),
    (s) => process.stdout.write(s),
    (s) => process.stderr.write(s),
  );
  process.exit(code);
}

module.exports = { run, formatView, USAGE };
