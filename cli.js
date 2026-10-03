#!/usr/bin/env node
// Usage: node cli.js <cmd.jsonl> [journalPath]
//
// cmd.jsonl holds one JSON command per line:
//   {"cmd":"import","file":"batches.jsonl","layer":1}   (layer optional)
//   {"cmd":"equiv","a":"rules-v1.jsonl","b":"rules-v2.jsonl"}
//   {"cmd":"rollback","layer":2}
// Each command prints one JSON object on stdout. Domain errors (cyclic
// lineage, unknown parent batch, layer hole) print a JSON error on stderr
// and exit with code 4.
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import {
  TraceabilitySystem,
  equivViews,
  parseBatchFile,
  viewFromRecords,
} from './src/system.js';
import { DOMAIN_EXIT_CODE, TraceError, ValidationError } from './src/errors.js';

function run(cmdFile, journalPath) {
  const baseDir = path.dirname(path.resolve(cmdFile));
  const system = new TraceabilitySystem(journalPath);
  const lines = fs.readFileSync(cmdFile, 'utf8').split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    if (!lines[i].trim()) continue;
    const cmd = JSON.parse(lines[i]);
    let out;
    if (cmd.cmd === 'import') {
      const records = parseBatchFile(path.resolve(baseDir, cmd.file));
      out = { cmd: 'import', ...system.importRecords(records, cmd.layer) };
    } else if (cmd.cmd === 'equiv') {
      const viewA = viewFromRecords(parseBatchFile(path.resolve(baseDir, cmd.a)));
      const viewB = viewFromRecords(parseBatchFile(path.resolve(baseDir, cmd.b)));
      out = { cmd: 'equiv', ...equivViews(viewA, viewB) };
    } else if (cmd.cmd === 'rollback') {
      out = { cmd: 'rollback', ...system.rollback(cmd.layer) };
    } else {
      throw new ValidationError(`unknown command: ${JSON.stringify(cmd.cmd)}`);
    }
    process.stdout.write(`${JSON.stringify(out)}\n`);
  }
}

const [cmdFile, journalArg] = process.argv.slice(2);
if (!cmdFile) {
  process.stderr.write('usage: node cli.js <cmd.jsonl> [journalPath]\n');
  process.exitCode = 1;
} else {
  try {
    run(cmdFile, journalArg ?? `${cmdFile}.journal`);
  } catch (err) {
    if (err instanceof TraceError) {
      process.stderr.write(
        `${JSON.stringify({ error: { code: err.code, message: err.message } })}\n`,
      );
      process.exitCode = DOMAIN_EXIT_CODE;
    } else {
      process.stderr.write(`${(err && err.stack) || err}\n`);
      process.exitCode = 1;
    }
  }
}
