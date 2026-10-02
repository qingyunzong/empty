#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { toTable, ReconError } from '../src/csv.js';
import { reconcile } from '../src/recon.js';

const SCHEMAS = {
  'internal.csv': [
    { name: 'date', type: 'date' },
    { name: 'account', type: 'string' },
    { name: 'txn_id', type: 'string' },
    { name: 'currency', type: 'string' },
    { name: 'amount', type: 'number' },
    { name: 'fee', type: 'number' },
  ],
  'bank.csv': [
    { name: 'date', type: 'date' },
    { name: 'account', type: 'string' },
    { name: 'txn_id', type: 'string' },
    { name: 'currency', type: 'string' },
    { name: 'amount', type: 'number' },
  ],
  'fee.csv': [
    { name: 'date', type: 'date' },
    { name: 'account', type: 'string' },
    { name: 'txn_id', type: 'string' },
    { name: 'currency', type: 'string' },
    { name: 'fee', type: 'number' },
  ],
};

function parseArgs(argv) {
  const args = { dir: null, out: null, explain: null, useIndex: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dir') args.dir = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--explain') args.explain = argv[++i];
    else if (a === '--no-index') args.useIndex = false;
    else throw new ReconError('E_SCHEMA', `unknown argument: ${a}`);
  }
  if (!args.dir || !args.out) {
    throw new ReconError('E_SCHEMA', 'usage: recon --dir <d> --out <r.json> [--explain plan.txt] [--no-index]');
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const tables = {};
  for (const [file, spec] of Object.entries(SCHEMAS)) {
    let text;
    try {
      text = readFileSync(join(args.dir, file), 'utf8');
    } catch (e) {
      throw new ReconError('E_SCHEMA', `cannot read ${file}: ${e.message}`);
    }
    tables[file] = toTable(text, file, spec);
  }
  const { result, plan } = reconcile(
    { internal: tables['internal.csv'], bank: tables['bank.csv'], fee: tables['fee.csv'] },
    { useIndex: args.useIndex },
  );
  writeFileSync(args.out, JSON.stringify(result, null, 2) + '\n');
  if (args.explain) writeFileSync(args.explain, plan);
}

try {
  main();
} catch (e) {
  const code = e instanceof ReconError ? e.code : 'E_INTERNAL';
  process.stderr.write(JSON.stringify({ code, message: e.message }) + '\n');
  process.exit(1);
}
