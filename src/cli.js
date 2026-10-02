#!/usr/bin/env node
'use strict';

const fs = require('fs');
const { appendBatch, recover } = require('./storage');
const { executeQuery } = require('./query');
const { QueryError } = require('./errors');

const USAGE = [
  'usage:',
  '  node src/cli.js append <log.jsonl> --db <dir>',
  '  node src/cli.js query <q.dsl> --db <dir>',
  '  node src/cli.js recover --db <dir>',
].join('\n');

function parseArgs(argv) {
  const positional = [];
  let db = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--db') {
      db = argv[++i];
    } else {
      positional.push(argv[i]);
    }
  }
  return { positional, db };
}

function normalizeRecord(obj, lineNo) {
  const bad = (msg) => new Error(`line ${lineNo}: ${msg}`);
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    throw bad('record must be a JSON object');
  }
  let ts = obj.ts;
  if (typeof ts === 'string') {
    ts = Date.parse(ts);
    if (Number.isNaN(ts)) throw bad(`invalid ts '${obj.ts}'`);
  }
  if (typeof ts !== 'number' || !Number.isFinite(ts)) throw bad('ts must be a number or ISO time string');
  if (typeof obj.device !== 'string' || obj.device === '') throw bad('device must be a non-empty string');
  if (typeof obj.code !== 'string') throw bad('code must be a string');
  if (typeof obj.value !== 'number' || !Number.isFinite(obj.value)) throw bad('value must be a finite number');
  return { ts, device: obj.device, code: obj.code, value: obj.value };
}

function cmdAppend(positional, db, io) {
  if (!db) throw new Error('append requires --db <dir>');
  const file = positional[0];
  if (!file) throw new Error('append requires a JSONL file');
  let lines;
  try {
    lines = fs.readFileSync(file, 'utf8').split('\n');
  } catch (err) {
    throw new Error(`cannot read '${file}': ${err.message}`);
  }
  const records = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === '') continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      throw new Error(`line ${i + 1}: invalid JSON`);
    }
    records.push(normalizeRecord(obj, i + 1));
  }
  const n = appendBatch(db, records);
  io.out(`APPENDED ${n}`);
  return 0;
}

function cmdQuery(positional, db, io) {
  if (!db) throw new Error('query requires --db <dir>');
  const file = positional[0];
  if (!file) throw new Error('query requires a DSL file');
  let source;
  try {
    source = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new Error(`cannot read '${file}': ${err.message}`);
  }
  let result;
  try {
    result = executeQuery(db, source);
  } catch (err) {
    if (err instanceof QueryError) {
      io.err(`QUERY_ERROR: ${err.message}`);
      return 2;
    }
    throw err;
  }
  if (result.kind === 'aggregate') {
    io.out(JSON.stringify(result.result));
  } else {
    for (const rec of result.records) io.out(JSON.stringify(rec));
  }
  return 0;
}

function cmdRecover(db, io) {
  if (!db) throw new Error('recover requires --db <dir>');
  try {
    const stats = recover(db);
    io.out(
      `RECOVERY_OK truncated_bytes=${stats.truncatedBytes}`
      + ` removed_orphans=${stats.removedOrphans.length}`
      + ` rebuilt_indexes=${stats.rebuiltIndexes.length}`
      + ` dropped_wal_records=${stats.droppedWalRecords}`,
    );
    return 0;
  } catch (err) {
    io.err(`RECOVERY_ERROR: ${err.message}`);
    return 1;
  }
}

function run(argv, io) {
  const out = io && io.out ? io.out : (s) => console.log(s);
  const err = io && io.err ? io.err : (s) => console.error(s);
  const [cmd, ...rest] = argv;
  const { positional, db } = parseArgs(rest);
  try {
    if (cmd === 'append') return cmdAppend(positional, db, { out, err });
    if (cmd === 'query') return cmdQuery(positional, db, { out, err });
    if (cmd === 'recover') return cmdRecover(db, { out, err });
    err(USAGE);
    return 1;
  } catch (err2) {
    err(`ERROR: ${err2.message}`);
    return 1;
  }
}

if (require.main === module) {
  process.exit(run(process.argv.slice(2)));
}

module.exports = { run };
