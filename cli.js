#!/usr/bin/env node
import { Store, verifyHistory } from './src/store.js';

function parseArgs(argv) {
  const positional = [];
  const opts = {};
  for (const arg of argv) {
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq === -1) opts[arg.slice(2)] = true;
      else opts[arg.slice(2, eq)] = arg.slice(eq + 1);
    } else {
      positional.push(arg);
    }
  }
  return { positional, opts };
}

function usage() {
  console.error(`usage:
  node cli.js add-edge <from> <to> [--dir=DIR] [--crash=before-checkpoint|after-checkpoint]
  node cli.js delete-edge <from> <to> [--dir=DIR] [--crash=...]
  node cli.js query-scc [--dir=DIR]
  node cli.js verify-history [--dir=DIR]`);
  process.exit(2);
}

const { positional, opts } = parseArgs(process.argv.slice(2));
const [command, ...rest] = positional;
const dir = typeof opts.dir === 'string' ? opts.dir : process.env.SETTLE_DIR ?? process.cwd();
const crash = typeof opts.crash === 'string' ? opts.crash : undefined;

if (crash && crash !== 'before-checkpoint' && crash !== 'after-checkpoint') {
  console.error(`unknown crash point: ${crash}`);
  process.exit(2);
}

try {
  switch (command) {
    case 'add-edge':
    case 'delete-edge': {
      const [from, to] = rest;
      if (!from || !to) usage();
      const store = Store.load(dir);
      const hash = store.commit(command, { from, to }, crash);
      console.log(`committed ${command} ${from} ${to} seq=${store.lastSeq} hash=${hash}`);
      break;
    }
    case 'query-scc': {
      const store = Store.load(dir);
      console.log(JSON.stringify(store.graph.scc()));
      break;
    }
    case 'verify-history': {
      const errors = verifyHistory(dir);
      if (errors.length > 0) {
        for (const error of errors) console.error(`FAIL: ${error}`);
        process.exit(1);
      }
      console.log('verify-history: OK');
      break;
    }
    default:
      usage();
  }
} catch (err) {
  console.error(`error: ${err.message}`);
  process.exit(1);
}
