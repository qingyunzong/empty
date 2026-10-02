#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { parseJsonl, reconcile, ReconError } from '../src/recon.js';

const USAGE =
  'usage: recon <bank.jsonl> <core.jsonl> <adj.jsonl> --out entries.jsonl --conflicts conflicts.json [--tol 0]';

function fail(message, code) {
  console.error(`recon: ${message}`);
  process.exit(code);
}

let args;
try {
  args = parseArgs({
    allowPositionals: true,
    options: {
      out: { type: 'string' },
      conflicts: { type: 'string' },
      tol: { type: 'string', default: '0' },
    },
  });
} catch (err) {
  fail(err.message, 2);
}

const [bankPath, corePath, adjPath] = args.positionals;
if (!bankPath || !corePath || !adjPath || !args.values.out || !args.values.conflicts) {
  console.error(USAGE);
  process.exit(2);
}

const tol = Number(args.values.tol);
if (!Number.isFinite(tol)) fail(`invalid --tol: ${args.values.tol}`, 2);

try {
  if (tol < 0) throw new ReconError(`negative tolerance: ${tol}`, 19);
  const bank = parseJsonl(readFileSync(bankPath, 'utf8'), 'bank');
  const core = parseJsonl(readFileSync(corePath, 'utf8'), 'core');
  const adj = parseJsonl(readFileSync(adjPath, 'utf8'), 'adj');
  const { entries, conflicts } = reconcile({ bank, core, adj, tol });
  writeFileSync(
    args.values.out,
    entries.map((e) => JSON.stringify(e)).join('\n') + (entries.length ? '\n' : ''),
  );
  writeFileSync(args.values.conflicts, JSON.stringify(conflicts, null, 2) + '\n');
  const byRule = {};
  for (const c of conflicts) byRule[c.rule] = (byRule[c.rule] ?? 0) + 1;
  console.log(`entries=${entries.length} conflicts=${conflicts.length} rules=${JSON.stringify(byRule)}`);
} catch (err) {
  if (err instanceof ReconError) fail(err.message, err.exitCode);
  throw err;
}
