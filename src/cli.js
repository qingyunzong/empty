#!/usr/bin/env node
// CLI over OrderStore.
//   node src/cli.js <datadir> append            # read JSONL events from stdin
//   node src/cli.js <datadir> event '<json>'    # add one event
//   node src/cli.js <datadir> delete <id>
//   node src/cli.js <datadir> undo <tradeId>
//   node src/cli.js <datadir> phrase "<text>"
//   node src/cli.js <datadir> near <window> <term...>
//   node src/cli.js <datadir> merge
//   node src/cli.js <datadir> liveness
//   node src/cli.js <datadir> report
// Exit codes: 0 ok, 2 known business error (code printed to stderr), 1 other.

import { OrderStore, StoreError } from './store.js';

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  const [, , dir, cmd, ...args] = process.argv;
  if (!dir || !cmd) {
    console.error('usage: cli.js <datadir> <command> [args...]');
    process.exit(1);
  }
  const store = await OrderStore.open(dir, { autoMerge: true });
  try {
    switch (cmd) {
      case 'append': {
        const input = await readStdin();
        let n = 0;
        for (const line of input.split('\n')) {
          if (!line.trim()) continue;
          store.addEvent(JSON.parse(line));
          n++;
        }
        console.log(JSON.stringify({ appended: n }));
        break;
      }
      case 'event': {
        const ev = store.addEvent(JSON.parse(args[0]));
        console.log(JSON.stringify(ev));
        break;
      }
      case 'delete': {
        await store.delete(args[0]);
        console.log(JSON.stringify({ deleted: args[0] }));
        break;
      }
      case 'undo': {
        console.log(JSON.stringify(store.undoTrade(args[0])));
        break;
      }
      case 'phrase': {
        console.log(JSON.stringify(store.phraseQuery(args[0])));
        break;
      }
      case 'near': {
        const [window, ...terms] = args;
        console.log(JSON.stringify(store.nearQuery(terms, Number(window))));
        break;
      }
      case 'merge': {
        console.log(JSON.stringify(await store.merge()));
        break;
      }
      case 'liveness': {
        console.log(JSON.stringify({ liveness: store.liveness() }));
        break;
      }
      case 'report': {
        console.log(JSON.stringify(store.report()));
        break;
      }
      default:
        console.error(`unknown command: ${cmd}`);
        process.exit(1);
    }
  } finally {
    await store.close();
  }
}

main().catch((err) => {
  if (err instanceof StoreError) {
    console.error(`ERROR ${err.code}: ${err.message}`);
    process.exit(2);
  }
  console.error(err.stack || String(err));
  process.exit(1);
});
