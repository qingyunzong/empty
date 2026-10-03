#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const { AuditLog, AuditError } = require('./src/audit');

// Runs the CLI. io = { stdout(s), stderr(s) }. Returns the exit code.
function run(argv, io) {
  const out = io && io.stdout ? io.stdout : (s) => process.stdout.write(s);
  const err = io && io.stderr ? io.stderr : (s) => process.stderr.write(s);
  try {
    main(argv, out);
    return 0;
  } catch (e) {
    const code = e && typeof e.code === 'string' ? e.code : 'E_INTERNAL';
    err(`${code}: ${e.message}\n`);
    return 1;
  }
}

function main(argv, out) {
  const args = argv.slice(2);
  let file = null;
  let asOf;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--as-of') {
      const raw = args[++i];
      asOf = Number(raw);
      if (raw === undefined || !Number.isFinite(asOf)) {
        throw new AuditError('E_INVALID_AS_OF', '--as-of requires a finite number');
      }
    } else if (file === null) {
      file = args[i];
    } else {
      throw new AuditError('E_USAGE', `unexpected argument: ${args[i]}`);
    }
  }
  if (file === null) {
    throw new AuditError('E_USAGE', 'usage: node cli.js <log.jsonl> [--as-of <t>]');
  }

  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    throw new AuditError('E_IO', `cannot read ${file}: ${e.message}`);
  }

  const log = new AuditLog();
  const emit = (t) => {
    const view = log.viewAt(t);
    out(
      JSON.stringify({
        asOf: view.asOf,
        visible: view.visible,
        hidden: view.hidden,
        hash: view.hash,
      }) + '\n'
    );
  };

  let emitted = false;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    let cmd;
    try {
      cmd = JSON.parse(line);
    } catch (e) {
      throw new AuditError('E_PARSE', `line ${i + 1}: ${e.message}`);
    }
    if (cmd !== null && typeof cmd === 'object' && cmd.op === 'asOf') {
      if (asOf === undefined) {
        if (!Number.isFinite(cmd.ts)) {
          throw new AuditError('E_INVALID_TS', `line ${i + 1}: asOf command needs a finite ts`);
        }
        emit(cmd.ts);
        emitted = true;
      }
      continue;
    }
    log.apply(cmd);
  }

  if (asOf !== undefined) emit(asOf);
  else if (!emitted) emit(Infinity);
}

if (require.main === module) {
  process.exit(run(process.argv));
}

module.exports = { run };
