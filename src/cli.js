#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const { SessionStore, toMillis } = require('./index');

const USAGE = 'usage: node src/cli.js sessions --in <file.jsonl>';

class FatalError extends Error {}

function fatal(message) {
  throw new FatalError(message);
}

function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  if (cmd !== 'sessions') fatal(`unknown command: ${cmd === undefined ? '(none)' : cmd}; ${USAGE}`);
  let inFile = null;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--in' && i + 1 < rest.length) {
      inFile = rest[++i];
    } else {
      fatal(`unknown argument: ${rest[i]}; ${USAGE}`);
    }
  }
  if (inFile === null) fatal(`missing --in <file.jsonl>; ${USAGE}`);
  return { inFile };
}

function isValidVersion(v) {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0;
}

// 返回退出码：0 成功（记录级错误不致命），2 致命错误。
function run(argv, io) {
  let inFile;
  try {
    ({ inFile } = parseArgs(argv));
  } catch (err) {
    if (err instanceof FatalError) {
      io.err(JSON.stringify({ error: 'FATAL', message: err.message }));
      return 2;
    }
    throw err;
  }

  let text;
  try {
    text = fs.readFileSync(inFile, 'utf8');
  } catch (err) {
    io.err(JSON.stringify({ error: 'FATAL', message: `cannot read input file: ${err.message}` }));
    return 2;
  }

  const store = new SessionStore();
  const lines = text.split(/\r?\n/);

  try {
    for (let idx = 0; idx < lines.length; idx++) {
      const lineNo = idx + 1;
      const line = lines[idx];
      if (line.trim() === '') continue;

      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        fatal(`line ${lineNo}: invalid JSON`);
      }
      if (rec === null || typeof rec !== 'object' || Array.isArray(rec)) {
        fatal(`line ${lineNo}: record must be a JSON object`);
      }

      if (rec.op === 'WATERMARK') {
        if (rec.ts === undefined || Number.isNaN(toMillis(rec.ts))) {
          fatal(`line ${lineNo}: WATERMARK requires a valid "ts"`);
        }
        for (const session of store.watermark(rec.ts)) {
          io.out(JSON.stringify(session));
        }
        continue;
      }

      if (rec.op === 'UPSERT') {
        if (typeof rec.id !== 'string' || rec.id === '') fatal(`line ${lineNo}: UPSERT requires string "id"`);
        if (typeof rec.station !== 'string' || rec.station === '') fatal(`line ${lineNo}: UPSERT requires string "station"`);
        if (rec.eventTime === undefined || Number.isNaN(toMillis(rec.eventTime))) fatal(`line ${lineNo}: UPSERT requires valid "eventTime"`);
        if (typeof rec.temp !== 'number' || !Number.isFinite(rec.temp)) fatal(`line ${lineNo}: UPSERT requires numeric "temp"`);
        if (!isValidVersion(rec.version)) fatal(`line ${lineNo}: UPSERT requires non-negative integer "version"`);
        const res = store.upsert(rec);
        if (!res.ok) {
          io.err(JSON.stringify({ line: lineNo, error: res.error, op: rec.op, id: rec.id }));
        }
        continue;
      }

      if (rec.op === 'RETRACT') {
        if (typeof rec.id !== 'string' || rec.id === '') fatal(`line ${lineNo}: RETRACT requires string "id"`);
        if (rec.version !== undefined && !isValidVersion(rec.version)) fatal(`line ${lineNo}: RETRACT "version" must be a non-negative integer`);
        if (rec.eventTime !== undefined && Number.isNaN(toMillis(rec.eventTime))) fatal(`line ${lineNo}: RETRACT "eventTime" is invalid`);
        const res = store.retract(rec);
        if (!res.ok) {
          io.err(JSON.stringify({ line: lineNo, error: res.error, op: rec.op, id: rec.id }));
        }
        continue;
      }

      fatal(`line ${lineNo}: unknown op: ${JSON.stringify(rec.op)}`);
    }
  } catch (err) {
    if (err instanceof FatalError) {
      io.err(JSON.stringify({ error: 'FATAL', message: err.message }));
      return 2;
    }
    throw err;
  }
  return 0;
}

if (require.main === module) {
  const code = run(process.argv.slice(2), {
    out: (l) => process.stdout.write(l + '\n'),
    err: (l) => process.stderr.write(l + '\n'),
  });
  process.exitCode = code;
}

module.exports = { run };
