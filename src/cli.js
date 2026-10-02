#!/usr/bin/env node
// CLI: node src/cli.js --input records.json --script script.cor
//      [--batch-size N] [--state state.json] [--crash N] [--output out.json]
//
// Exit codes: 0 success, 1 correction failure (batch rolled back), 3 simulated crash.

import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { compile } from './compiler.js';
import { runPipeline, CrashError } from './runner.js';

export function csvRowsToRecords(csvRows) {
  if (csvRows.length === 0) return [];
  const header = csvRows[0].fields;
  return csvRows.slice(1).map((row) => {
    const record = {};
    header.forEach((name, i) => {
      const raw = row.fields[i] ?? '';
      const num = Number(raw);
      record[name] = raw !== '' && !Number.isNaN(num) ? num : raw;
    });
    return record;
  });
}

export function main(argv = process.argv.slice(2)) {
  const { values } = parseArgs({
    args: argv,
    options: {
      input: { type: 'string' },
      script: { type: 'string' },
      'batch-size': { type: 'string', default: '10' },
      state: { type: 'string' },
      crash: { type: 'string' },
      output: { type: 'string' },
    },
  });
  if (!values.input || !values.script) {
    process.stderr.write('usage: cli.js --input records.json --script script.cor [--batch-size N] [--state state.json] [--crash N] [--output out.json]\n');
    return 2;
  }

  const inputRecords = JSON.parse(fs.readFileSync(values.input, 'utf8'));
  if (!Array.isArray(inputRecords)) {
    process.stderr.write('error: input must be a JSON array of records\n');
    return 2;
  }
  const { code, csvRows } = compile(fs.readFileSync(values.script, 'utf8'));
  const records = [...inputRecords, ...csvRowsToRecords(csvRows)];

  try {
    const result = runPipeline({
      records,
      code,
      batchSize: Number(values['batch-size']),
      statePath: values.state ?? null,
      crashAfter: values.crash !== undefined ? Number(values.crash) : null,
    });
    const json = JSON.stringify(result, null, 2) + '\n';
    if (values.output) fs.writeFileSync(values.output, json);
    else process.stdout.write(json);
    return result.ok ? 0 : 1;
  } catch (err) {
    if (err instanceof CrashError) {
      process.stderr.write(`crash: ${err.message}\n`);
      return 3;
    }
    throw err;
  }
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main());
}
