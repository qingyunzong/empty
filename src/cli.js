#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { runEngine } from './engine.js';

// Usage: node src/cli.js run <rules.dsl> <events.jsonl> [--out result.json]
// Exit codes: 0 = success, 1 = usage/IO error, 2 = rule diagnostics or domain errors.

const EXIT_OK = 0;
const EXIT_USAGE = 1;
const EXIT_DIAGNOSTIC = 2;

function usage() {
  console.error('usage: node src/cli.js run <rules.dsl> <events.jsonl> [--out result.json]');
  process.exit(EXIT_USAGE);
}

const args = process.argv.slice(2);
if (args[0] !== 'run') usage();
const positional = [];
let outPath = null;
for (let i = 1; i < args.length; i++) {
  if (args[i] === '--out') {
    if (i + 1 >= args.length) usage();
    outPath = args[++i];
  } else if (args[i].startsWith('--')) {
    usage();
  } else {
    positional.push(args[i]);
  }
}
if (positional.length !== 2) usage();
const [rulesPath, eventsPath] = positional;

let rulesSrc, eventsText;
try {
  rulesSrc = readFileSync(rulesPath, 'utf8');
  eventsText = readFileSync(eventsPath, 'utf8');
} catch (e) {
  console.error(`error: cannot read input file: ${e.message}`);
  process.exit(EXIT_USAGE);
}

const result = runEngine(rulesSrc, eventsText);
const json = JSON.stringify(result, null, 2) + '\n';
if (outPath) {
  writeFileSync(outPath, json);
} else {
  process.stdout.write(json);
}

for (const err of result.errors) {
  const where = err.event != null ? `event ${err.event}`
    : err.line != null ? `${rulesPath}:${err.line}:${err.col ?? 1}`
    : err.phase;
  console.error(`error [${err.phase}] ${where}: ${err.message}`);
}
console.error(
  `${result.ok ? 'ok' : 'failed'}: ${result.stats.events} events, ` +
  `${result.stats.alerts} alerts, ${result.stats.withdraws} withdraws, ` +
  `${result.errors.length} errors`,
);
process.exit(result.ok ? EXIT_OK : EXIT_DIAGNOSTIC);
