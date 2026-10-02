#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { loadPolicy, loadStock, parseEvents } from './model.js';
import { runBatch } from './decide.js';
import { audit, minimalMissingConstraints, ALL_CHECKS } from './audit.js';
import { ExitError } from './errors.js';

const USAGE = `Usage:
  node src/cli.js run --defects defects.jsonl --policy policy.json --stock stock.json \
      --decisions decision.jsonl --ledger ledger.jsonl
  node src/cli.js audit --policy policy.json --stock stock.json --ledger ledger.jsonl \
      [--checks a,b,c] [--counterexample]

Exit codes: 19 negative stock, 20 unknown budget currency, 21 duplicate defect id.`;

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      if (key === 'counterexample') { args[key] = true; continue; }
      i += 1;
      if (i >= argv.length) throw new Error(`missing value for --${key}`);
      args[key] = argv[i];
    } else {
      args._.push(arg);
    }
  }
  return args;
}

function toJsonl(rows) {
  return rows.map((row) => JSON.stringify(row)).join('\n') + '\n';
}

function cmdRun(args) {
  for (const key of ['defects', 'policy', 'stock', 'decisions', 'ledger']) {
    if (!args[key]) throw new Error(`run requires --${key}`);
  }
  const policy = loadPolicy(readFileSync(args.policy, 'utf8'));
  const stock = loadStock(readFileSync(args.stock, 'utf8'));
  const events = parseEvents(readFileSync(args.defects, 'utf8'));
  const { decisions, ledger } = runBatch(policy, stock, events);
  writeFileSync(args.decisions, toJsonl(decisions));
  writeFileSync(args.ledger, toJsonl(ledger));
  return `${decisions.length} decisions, ${ledger.length} ledger entries\n`;
}

function cmdAudit(args) {
  for (const key of ['policy', 'stock', 'ledger']) {
    if (!args[key]) throw new Error(`audit requires --${key}`);
  }
  const policy = loadPolicy(readFileSync(args.policy, 'utf8'));
  const stock = loadStock(readFileSync(args.stock, 'utf8'));
  const ledger = readFileSync(args.ledger, 'utf8').split('\n')
    .filter((line) => line.trim() !== '').map((line) => JSON.parse(line));
  const checks = args.checks ? args.checks.split(',') : ALL_CHECKS;
  const result = audit(policy, stock, ledger, checks);
  const out = { checks, ok: result.ok, violations: result.violations };
  if (args.counterexample && result.ok) {
    out.counterexample = minimalMissingConstraints(policy, stock, ledger, checks);
  }
  return { text: JSON.stringify(out, null, 2) + '\n', code: result.ok ? 0 : 1 };
}

// Returns the process exit code; `io` is injectable for tests.
export function main(argv, io = { stdout: (s) => process.stdout.write(s), stderr: (s) => process.stderr.write(s) }) {
  try {
    const args = parseArgs(argv);
    const command = args._.shift();
    if (command === 'run') {
      io.stdout(cmdRun(args));
      return 0;
    }
    if (command === 'audit') {
      const { text, code } = cmdAudit(args);
      io.stdout(text);
      return code;
    }
    io.stderr(`${USAGE}\n`);
    return 2;
  } catch (err) {
    io.stderr(`error: ${err.message}\n`);
    return err instanceof ExitError ? err.code : 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
