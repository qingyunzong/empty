#!/usr/bin/env node
// CLI: node src/cli.js run rules.dsl events.jsonl --out result.json
//
// Exit codes:
//   0  success; result JSON written
//   1  usage or I/O error (nothing written)
//   2  diagnostics: DSL errors (line:col) or event/domain errors (event seq).
//      For domain errors the result JSON is still written with the records
//      derived from the deterministically processed events.

import { readFileSync, writeFileSync, writeSync } from 'node:fs';
import { compile } from './index.js';
import { Engine } from './engine.js';

const USAGE = 'usage: sentinel run <rules.dsl> <events.jsonl> --out <result.json>';

// Synchronous stderr write so diagnostics survive process.exit().
const errOut = (msg) => writeSync(2, msg);

function failUsage(message) {
  errOut(`error: ${message}\n${USAGE}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  if (argv.length < 1 || argv[0] !== 'run') failUsage('expected subcommand "run"');
  const positional = [];
  let out = null;
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === '--out') {
      if (i + 1 >= argv.length) failUsage('--out requires a path');
      out = argv[++i];
    } else if (argv[i].startsWith('--')) {
      failUsage(`unknown option '${argv[i]}'`);
    } else {
      positional.push(argv[i]);
    }
  }
  if (positional.length !== 2) failUsage('expected <rules.dsl> and <events.jsonl>');
  return { rulesPath: positional[0], eventsPath: positional[1], out };
}

function readFile(path, what) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    errOut(`error: cannot read ${what} file '${path}'\n`);
    process.exit(1);
  }
}

function main(argv) {
  const { rulesPath, eventsPath, out } = parseArgs(argv);

  const source = readFile(rulesPath, 'rules');
  let rules;
  try {
    rules = compile(source);
  } catch (err) {
    if (err && err.line !== undefined) {
      errOut(`${rulesPath}:${err.line}:${err.col}: error: ${err.message}\n`);
      process.exit(2);
    }
    throw err;
  }

  const lines = readFile(eventsPath, 'events').split('\n');
  const engine = new Engine(rules);
  let seq = 0;
  for (const line of lines) {
    if (line.trim() === '') continue;
    seq += 1;
    let record;
    try {
      record = JSON.parse(line);
    } catch (err) {
      engine.store.errors.push({ seq, error: `invalid JSON: ${err.message}` });
      continue;
    }
    engine.process(record, seq);
  }

  const errors = engine.errors;
  const alerts = engine.records.filter((r) => r.type === 'alert').length;
  const withdrawals = engine.records.filter((r) => r.type === 'withdraw').length;
  const result = {
    ok: errors.length === 0,
    rules: rules.map((r) => r.name),
    stats: { events: seq, alerts, withdrawals, errors: errors.length },
    records: engine.records,
    errors,
  };
  const json = JSON.stringify(result, null, 2) + '\n';
  if (out) {
    writeFileSync(out, json);
  } else {
    process.stdout.write(json);
  }
  for (const e of errors) {
    errOut(`${eventsPath}: event #${e.seq}: error: ${e.error}\n`);
  }
  process.exit(errors.length === 0 ? 0 : 2);
}

main(process.argv.slice(2));
