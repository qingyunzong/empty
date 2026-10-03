#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseJsonl, parseRollbackSpec, run, CyclicParentError } from './lib/recon.js';

function usage(io) {
  io.stderr(
    'usage: node cli.js recon --base <confirmed.jsonl> --deltas <deltas.jsonl> ' +
      '[--rollback day|mch|txn:target[@version]]... [--watermark <iso-time>] [--out <file>|"-" for stdout]\n',
  );
}

function parseArgs(argv) {
  const opts = { rollbacks: [], out: 'versions.jsonl' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--base') opts.base = argv[++i];
    else if (arg === '--deltas') opts.deltas = argv[++i];
    else if (arg === '--rollback') opts.rollbacks.push(argv[++i]);
    else if (arg === '--watermark') opts.watermark = argv[++i];
    else if (arg === '--out') opts.out = argv[++i];
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!opts.base || !opts.deltas) throw new Error('missing required --base/--deltas');
  return opts;
}

export function runCli(argv, io = { stdout: (s) => process.stdout.write(s), stderr: (s) => process.stderr.write(s) }) {
  const [command, ...rest] = argv;
  if (command !== 'recon') {
    usage(io);
    return 2;
  }
  let opts;
  try {
    opts = parseArgs(rest);
  } catch (err) {
    io.stderr(`error: ${err.message}\n`);
    usage(io);
    return 2;
  }
  try {
    const confirmedRows = parseJsonl(readFileSync(opts.base, 'utf8'));
    const deltaRows = parseJsonl(readFileSync(opts.deltas, 'utf8'));
    const specs = opts.rollbacks.map(parseRollbackSpec);
    const rows = run({
      confirmedRows,
      deltaRows,
      rollbacks: specs,
      watermark: opts.watermark ?? null,
    });
    const text = rows.map((row) => JSON.stringify(row)).join('\n') + '\n';
    if (opts.out === '-') io.stdout(text);
    else writeFileSync(opts.out, text);
    return 0;
  } catch (err) {
    if (err instanceof CyclicParentError || err?.code === 'CYCLIC_PARENT') {
      io.stderr(`error: cyclic parent chain (${err.target ?? 'unknown target'})\n`);
      return 6;
    }
    io.stderr(`error: ${err.message}\n`);
    return 1;
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  process.exit(runCli(process.argv.slice(2)));
}
