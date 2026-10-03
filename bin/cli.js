#!/usr/bin/env node
import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { Store, StoreError } from '../src/store.js';

const usage = `usage: order-store [--dir <path>] <command> [args]
commands:
  append '{"id":"e1","tradeId":"t1","fee":10,"refundBudget":100,"text":"...","state":"open"}'
  delete <eventId>
  phrase <terms...>
  near <terms...> [--window N]
  undo <tradeId>
  merge
  stats
`;

export function main(argv, io = {}) {
  const out = io.out ?? ((s) => process.stdout.write(s));
  const err = io.err ?? ((s) => process.stderr.write(s));

  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        dir: { type: 'string', default: './data' },
        window: { type: 'string', default: '5' },
        help: { type: 'boolean', default: false },
      },
    });
  } catch (error) {
    err(`${error.message}\n${usage}`);
    return 2;
  }

  const { values, positionals } = parsed;
  const [command, ...rest] = positionals;

  if (values.help || !command) {
    out(usage);
    return command ? 0 : 2;
  }

  const print = (value) => out(JSON.stringify(value) + '\n');
  const store = Store.open(values.dir);

  try {
    switch (command) {
      case 'append':
        print(store.append(JSON.parse(rest[0])));
        break;
      case 'delete':
        print(store.delete(rest[0]));
        break;
      case 'phrase':
        print({ ids: store.queryPhrase(rest.join(' ')) });
        break;
      case 'near':
        print({ ids: store.queryNear(rest.join(' '), Number(values.window)) });
        break;
      case 'undo':
        print(store.undoTrade(rest[0]));
        break;
      case 'merge':
        print(store.merge());
        break;
      case 'stats':
        print(store.stats());
        break;
      default:
        err(`unknown command: ${command}\n${usage}`);
        return 2;
    }
  } catch (error) {
    if (error instanceof StoreError) {
      err(`${error.code}: ${error.message}\n`);
      return 1;
    }
    throw error;
  }
  return 0;
}

const invokedAsScript = process.argv[1]
  && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1]);
if (invokedAsScript) {
  process.exitCode = main(process.argv.slice(2));
}
