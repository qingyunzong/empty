#!/usr/bin/env node
import { parseArgs } from 'node:util';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { TradeStore, StoreError } from './store.js';

const OPTIONS = {
  dir: { type: 'string', default: './data' },
  'margin-rate': { type: 'string', default: '0.1' },
  threshold: { type: 'string', default: '0.5' },
  id: { type: 'string' },
  buyer: { type: 'string' },
  seller: { type: 'string' },
  amount: { type: 'string' },
  desc: { type: 'string', default: '' },
  k: { type: 'string', default: '10' },
  a: { type: 'string' },
  b: { type: 'string' },
  name: { type: 'string' },
  balance: { type: 'string' },
};

const USAGE = `usage: node src/cli.js <command> [options]
commands:
  add      --id T1 --buyer A --seller B --amount 100 --desc "text"
  revoke   --id T1
  delete   --id T1
  phrase   "some phrase"
  near     "term1 term2" [--k 10]
  pair     --a A --b B
  account  --name A --balance 1000
  compact
  segments
global options: --dir ./data --margin-rate 0.1 --threshold 0.5`;

export function main(argv) {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === 'help' || cmd === '--help') {
    console.log(USAGE);
    return 0;
  }
  const { values: v, positionals } = parseArgs({
    args: rest,
    options: OPTIONS,
    allowPositionals: true,
  });
  const store = TradeStore.open(v.dir, {
    marginRate: Number(v['margin-rate']),
    compactionThreshold: Number(v.threshold),
  });
  const out = (obj) => console.log(JSON.stringify(obj, null, 2));
  switch (cmd) {
    case 'add':
      out(
        store.addTrade({
          id: v.id,
          buyer: v.buyer,
          seller: v.seller,
          amount: Number(v.amount),
          desc: v.desc,
        }),
      );
      store.save();
      break;
    case 'revoke':
      out(store.revokeTrade(v.id));
      store.save();
      break;
    case 'delete':
      out(store.deleteTrade(v.id));
      store.save();
      break;
    case 'phrase':
      out(store.phraseQuery(positionals[0] ?? ''));
      break;
    case 'near':
      out(store.nearQuery(positionals[0] ?? '', Number(v.k)));
      break;
    case 'pair':
      out(store.pairSettlement(v.a, v.b));
      break;
    case 'account':
      store.ledger.setBalance(v.name, Number(v.balance));
      store.save();
      out({ account: v.name, balance: Number(v.balance) });
      break;
    case 'compact':
      out({ compacted: store.compact() });
      store.save();
      break;
    case 'segments':
      out(store.index.segmentReport());
      break;
    default:
      console.error(`unknown command: ${cmd}\n${USAGE}`);
      return 2;
  }
  return 0;
}

const isMain =
  process.argv[1] &&
  fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
if (isMain) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    if (err instanceof StoreError || err.code) {
      console.error(JSON.stringify({ error: err.code, message: err.message }));
      process.exitCode = 1;
    } else {
      throw err;
    }
  }
}
