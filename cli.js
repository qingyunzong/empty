#!/usr/bin/env node
import { Store } from './src/store.js';
import { StoreError } from './src/errors.js';

function parseArgs(argv) {
  const args = { lots: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) throw new StoreError('E_USAGE', `unexpected argument ${a}`);
    const k = a.slice(2);
    if (k === 'quarantine') {
      args.quarantine = true;
      continue;
    }
    const v = argv[++i];
    if (v === undefined) throw new StoreError('E_USAGE', `missing value for --${k}`);
    if (k === 'lot') args.lots.push(v);
    else args[k] = v;
  }
  return args;
}

function need(args, ...keys) {
  for (const k of keys) {
    if (args[k] === undefined) throw new StoreError('E_USAGE', `--${k} is required`);
  }
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  let out;
  switch (cmd) {
    case 'init': {
      need(args, 'dir');
      Store.init(args.dir);
      out = { ok: true };
      break;
    }
    case 'put': {
      need(args, 'dir', 'pallet');
      if (args.lots.length !== 1) throw new StoreError('E_USAGE', 'exactly one --lot is required');
      const store = Store.open(args.dir);
      const r = store.put(args.pallet, args.lots[0], { quarantine: !!args.quarantine });
      out = { ok: true, txid: r.txid };
      break;
    }
    case 'transfer': {
      need(args, 'dir', 'from', 'to');
      if (args.lots.length === 0) throw new StoreError('E_USAGE', 'at least one --lot is required');
      let crashPoint = null;
      if (args['crash-after'] !== undefined) {
        if (args['crash-after'] === 'records') crashPoint = 'after_records';
        else if (args['crash-after'] === 'commit') crashPoint = 'after_commit';
        else throw new StoreError('E_USAGE', '--crash-after must be records or commit');
      }
      const store = Store.open(args.dir);
      const r = store.transfer(args.from, args.to, args.lots, {
        quarantine: !!args.quarantine,
        crashPoint,
      });
      out = { ok: true, txid: r.txid };
      break;
    }
    case 'state': {
      need(args, 'dir');
      const store = Store.open(args.dir);
      out = { ok: true, ...store.dump() };
      break;
    }
    default:
      throw new StoreError('E_USAGE', `unknown command ${JSON.stringify(cmd)}`);
  }
  process.stdout.write(JSON.stringify(out) + '\n');
}

try {
  main();
} catch (e) {
  if (e instanceof StoreError) {
    process.stdout.write(JSON.stringify({ ok: false, code: e.code, message: e.message }) + '\n');
    process.exit(e.code === 'E_CORRUPT' ? 2 : e.code === 'E_CRASH' ? 3 : 1);
  }
  throw e;
}
