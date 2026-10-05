#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const { Settler } = require('./lib/settle');
const { naiveRun } = require('./lib/naive');

const USAGE =
  'usage: node cli.js settle --in <events.jsonl> --wm <latenessMs> --out <out.jsonl> [--naive]';

function parseArgs(argv) {
  const opts = { naive: false };
  const rest = argv.slice(2);
  if (rest[0] !== 'settle') return null;
  for (let i = 1; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--naive') opts.naive = true;
    else if (a === '--in') opts.inFile = rest[++i];
    else if (a === '--out') opts.outFile = rest[++i];
    else if (a === '--wm') opts.wm = rest[++i];
    else return null;
  }
  if (!opts.inFile || !opts.outFile || opts.wm === undefined) return null;
  const wm = Number(opts.wm);
  if (!Number.isInteger(wm) || wm < 0) return null;
  opts.wm = wm;
  return opts;
}

// logger defaults to console; injectable for tests.
function main(argv, logger = console) {
  const opts = parseArgs(argv);
  if (!opts) {
    logger.error(USAGE);
    return 1;
  }

  let content;
  try {
    content = fs.readFileSync(opts.inFile, 'utf8');
  } catch (e) {
    logger.error(`error: cannot read ${opts.inFile}: ${e.message}`);
    return 1;
  }

  const parsed = [];
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      parsed.push({ ev: JSON.parse(line), lineNo: i + 1 });
    } catch {
      logger.error(`error: invalid JSON at line ${i + 1}`);
      return 2;
    }
  }

  const settler = new Settler({ allowedLatenessMs: opts.wm });
  for (const { ev, lineNo } of parsed) settler.process(ev, lineNo);
  const records = settler.finish();

  if (opts.naive) {
    if (parsed.length > 200) {
      logger.error(`warning: --naive is intended for <=200 events (got ${parsed.length})`);
    }
    const naiveRecords = naiveRun(parsed, opts.wm);
    if (JSON.stringify(records) !== JSON.stringify(naiveRecords)) {
      logger.error('error: naive full-replay mismatch against streaming result');
      return 3;
    }
    logger.error(`naive replay verified: ${naiveRecords.length} records match`);
  }

  const out = records.map((r) => JSON.stringify(r)).join('\n');
  fs.writeFileSync(opts.outFile, out ? out + '\n' : '');

  const finals = records.filter((r) => r.status === 'final').length;
  const corrections = records.filter((r) => r.status === 'correction').length;
  const errors = records.filter((r) => r.status === 'error').length;
  const late = records.filter((r) => r.status === 'late').length;
  logger.log(
    `settled: ${finals} window records, ${corrections} corrections, ` +
      `${late} late, ${errors} errors -> ${opts.outFile}`
  );
  return 0;
}

if (require.main === module) {
  process.exitCode = main(process.argv);
}

module.exports = { main };
