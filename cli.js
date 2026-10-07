#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const {
  TzRegistry,
  normalizeRates,
  postLedger,
  applyCorrection,
  reconcile,
  ReconError,
} = require('./index');

const USAGE = `Usage: node cli.js <command> [options]

Commands:
  post        Build a ledger from transactions (pins a tz table version)
  reconcile   Diff a ledger against a settlement statement
  correct     Apply a correction; recompute only intersecting rate intervals

Options:
  --txns <file>        Transactions JSON (post)
  --tz <file>          Timezone table JSON; repeatable, hot-loads versions
  --tz-version <v>     Pin this table version (default: latest loaded)
  --policy <p>         strict | earlier | later (default: strict)
  --rates <file>       FX rate intervals JSON
  --ledger <file>      Ledger JSON (reconcile, correct)
  --settlement <file>  Settlement statement JSON (reconcile)
  --correction <file>  Correction JSON (correct)
  --allow-repin        Permit explicit tz version migration on correction
  --out <file>         Write output to file instead of stdout
`;

function parseArgs(argv) {
  const args = { tz: [] };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      if (key === 'allow-repin') {
        args.allowRepin = true;
      } else {
        const value = argv[++i];
        if (value === undefined) throw new Error(`missing value for ${a}`);
        if (key === 'tz') args.tz.push(value);
        else args[key.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value;
      }
    } else {
      positional.push(a);
    }
  }
  return { command: positional[0], args };
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function buildRegistry(files) {
  const registry = new TzRegistry();
  for (const f of files) registry.load(readJson(f));
  return registry;
}

function emit(data, out) {
  const text = JSON.stringify(data, null, 2) + '\n';
  if (out) fs.writeFileSync(out, text);
  else process.stdout.write(text);
}

function main() {
  const { command, args } = parseArgs(process.argv.slice(2));
  const policy = args.policy || 'strict';

  switch (command) {
    case 'post': {
      const registry = buildRegistry(args.tz);
      const rates = normalizeRates(readJson(args.rates));
      const txns = readJson(args.txns);
      const ledger = postLedger({ txns, registry, tzVersion: args.tzVersion, policy, rates });
      emit(ledger, args.out);
      break;
    }
    case 'reconcile': {
      const ledger = readJson(args.ledger);
      const settlement = readJson(args.settlement);
      emit(reconcile(ledger, settlement), args.out);
      break;
    }
    case 'correct': {
      const registry = buildRegistry(args.tz);
      const rates = normalizeRates(readJson(args.rates));
      const ledger = readJson(args.ledger);
      const correction = readJson(args.correction);
      const next = applyCorrection(ledger, correction, {
        registry,
        rates,
        policy,
        allowRepin: args.allowRepin === true,
      });
      emit({ impact: next.lastImpact, ledger: next }, args.out);
      break;
    }
    default:
      process.stderr.write(USAGE);
      process.exitCode = command ? 2 : 0;
  }
}

try {
  main();
} catch (err) {
  if (err instanceof ReconError) {
    process.stderr.write(`${err.code}: ${err.message}\n`);
    process.exitCode = 1;
  } else {
    throw err;
  }
}
