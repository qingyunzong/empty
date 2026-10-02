#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { appendBatch, normalizeRecord, recover, RecoveryError } from './storage.js';
import { executeQuery } from './query.js';
import { DslSyntaxError, DslTypeError } from './lexer.js';

export const EXIT = { OK: 0, ERROR: 1, SYNTAX: 2, TYPE: 3 };

const USAGE = `usage:
  logdb append <log.jsonl> [--db dir]   append JSONL log records
  logdb query <q.dsl> [--db dir]        run a query DSL file
  logdb recover [--db dir]              recover database after a crash

exit codes:
  0  success
  1  generic error (I/O, invalid input, recovery failure)
  2  query syntax error
  3  query static error (unknown field, type mismatch)
`;

function parseArgs(argv) {
  const positional = [];
  let db = './logdb';
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--db') {
      if (i + 1 >= argv.length) throw new Error('--db requires a directory');
      db = argv[++i];
    } else if (argv[i].startsWith('--db=')) {
      db = argv[i].slice('--db='.length);
    } else {
      positional.push(argv[i]);
    }
  }
  return { positional, db };
}

function cmdAppend(file, db, out) {
  const raw = fs.readFileSync(file, 'utf8');
  const records = [];
  const lines = raw.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === '') continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      throw new Error(`invalid JSON on line ${i + 1} of ${file}`);
    }
    records.push(normalizeRecord(obj, i + 1));
  }
  const { appended } = appendBatch(db, records);
  out(`APPENDED ${appended}`);
}

function cmdQuery(file, db, out) {
  const src = fs.readFileSync(file, 'utf8');
  const result = executeQuery(db, src);
  if (result.kind === 'aggregate') {
    out(JSON.stringify(result.result));
  } else {
    for (const rec of result.result) out(JSON.stringify(rec));
  }
}

function cmdRecover(db, out) {
  const summary = recover(db);
  out(`RECOVERED truncatedWalBytes=${summary.truncatedWalBytes} `
    + `replayedRecords=${summary.replayedRecords} `
    + `orphansRemoved=${summary.orphansRemoved.length} `
    + `indexesRebuilt=${summary.indexesRebuilt.length}`);
}

// Runs the CLI and returns the process exit code. Output goes through the
// injected writers so tests can capture it in-process.
export function runCli(argv, io = {}) {
  const out = io.stdout ?? ((line) => console.log(line));
  const err = io.stderr ?? ((line) => console.error(line));
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === '-h' || cmd === '--help') {
    (io.stdout ?? ((s) => process.stdout.write(s)))(USAGE);
    return cmd ? EXIT.OK : EXIT.ERROR;
  }
  try {
    const { positional, db } = parseArgs(rest);
    if (cmd === 'append') {
      if (positional.length !== 1) throw new Error('append requires exactly one JSONL file');
      cmdAppend(positional[0], db, out);
    } else if (cmd === 'query') {
      if (positional.length !== 1) throw new Error('query requires exactly one DSL file');
      cmdQuery(positional[0], db, out);
    } else if (cmd === 'recover') {
      if (positional.length !== 0) throw new Error('recover takes no file argument');
      cmdRecover(db, out);
    } else {
      throw new Error(`unknown command '${cmd}'`);
    }
    return EXIT.OK;
  } catch (e) {
    if (e instanceof DslSyntaxError) {
      err(`SYNTAX_ERROR: ${e.message}`);
      return EXIT.SYNTAX;
    }
    if (e instanceof DslTypeError) {
      err(`TYPE_ERROR: ${e.message}`);
      return EXIT.TYPE;
    }
    if (e instanceof RecoveryError) {
      err(`RECOVERY_ERROR: ${e.message}`);
      return EXIT.ERROR;
    }
    err(`ERROR: ${e.message}`);
    return EXIT.ERROR;
  }
}

const isMain = process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  process.exit(runCli(process.argv.slice(2)));
}
