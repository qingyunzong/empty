#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { openStore } from './lib/store.js';

function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      if (key === 'includeHistory') opts[key] = true;
      else { opts[key] = argv[i + 1]; i += 1; }
    } else {
      opts._.push(a);
    }
  }
  return opts;
}

const USAGE = `usage: node cli.js --data DIR <command> [options]
  deposit  --wallet W --amount N --rev R
  freeze   --wallet W --amount N --memo M --rev R [--id ID]
  release  --id ID --rev R
  cancel   --id ID --rev R
  balance  --wallet W
  search   --query Q [--window K] [--include-history]
  holds    [--include-history]
  compact
  verify`;

/** Run one CLI invocation. Returns exit code; prints JSON via `print`. */
export function runCli(argv, print = console.log, errprint = console.error) {
  const opts = parseArgs(argv);
  const [cmd] = opts._;
  if (!opts.data || !cmd) {
    errprint(USAGE);
    return 64;
  }
  const store = openStore(opts.data, {
    compactThreshold: opts.compactThreshold ? Number(opts.compactThreshold) : 100,
  });
  const num = (v) => (v === undefined ? undefined : Number(v));
  let result;
  switch (cmd) {
    case 'deposit':
      result = store.deposit({ wallet: opts.wallet, amount: num(opts.amount), rev: num(opts.rev) });
      break;
    case 'freeze':
      result = store.freeze({
        wallet: opts.wallet, amount: num(opts.amount), memo: opts.memo,
        rev: num(opts.rev), id: opts.id,
      });
      break;
    case 'release':
      result = store.release({ id: opts.id, rev: num(opts.rev) });
      break;
    case 'cancel':
      result = store.cancel({ id: opts.id, rev: num(opts.rev) });
      break;
    case 'balance':
      result = store.balance(opts.wallet);
      break;
    case 'search':
      result = store.search(opts.query ?? '', {
        window: num(opts.window), includeHistory: Boolean(opts.includeHistory),
      });
      break;
    case 'holds':
      result = { ok: true, holds: store.listHolds({ includeHistory: Boolean(opts.includeHistory) }) };
      break;
    case 'compact':
      result = store.compact();
      break;
    case 'verify':
      result = store.verify();
      break;
    default:
      errprint(USAGE);
      return 64;
  }
  print(JSON.stringify(result, null, 2));
  if (!result.ok) return result.error === 'CONFLICT' ? 2 : 1;
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(runCli(process.argv.slice(2)));
}
