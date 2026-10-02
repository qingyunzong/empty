#!/usr/bin/env node
// Usage:
//   node cli.js [--dir STORE] put <id> [--file <path> | --text <text>]
//   node cli.js [--dir STORE] del <id>
//   node cli.js [--dir STORE] query <phrase...>
//   node cli.js [--dir STORE] prove <id>
//   node cli.js [--dir STORE] recover
// Errors print "E_CHAIN|E_TORN|E_ABSENT: <message>" on stderr, exit 1.
import fs from 'node:fs';
import { put, del, query, prove, recover, StoreError } from './lib/store.js';

function usage() {
  console.error('usage: cli.js [--dir STORE] <put|del|query|prove|recover> ...');
}

const argv = process.argv.slice(2);
let dir = process.env.CERT_STORE_DIR ?? 'store';
const rest = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--dir') dir = argv[++i];
  else rest.push(argv[i]);
}
const [cmd, ...args] = rest;

try {
  switch (cmd) {
    case 'put': {
      const [id, ...source] = args;
      let text;
      if (source[0] === '--file') text = fs.readFileSync(source[1], 'utf8');
      else if (source[0] === '--text') text = source[1];
      else if (source.length > 0) text = source.join(' ');
      else text = fs.readFileSync(0, 'utf8');
      const r = put(dir, id, text);
      console.log(`ok put ${r.id} epoch=${r.epoch} hash=${r.hash}`);
      break;
    }
    case 'del': {
      const r = del(dir, args[0]);
      console.log(`ok del ${r.id} epoch=${r.epoch}`);
      break;
    }
    case 'query': {
      for (const id of query(dir, args.join(' '))) console.log(id);
      break;
    }
    case 'prove': {
      console.log(JSON.stringify(prove(dir, args[0]), null, 2));
      break;
    }
    case 'recover': {
      for (const line of recover(dir)) console.log(line);
      break;
    }
    default:
      usage();
      process.exit(cmd ? 1 : 0);
  }
} catch (err) {
  if (err instanceof StoreError) {
    console.error(`${err.code}: ${err.message}`);
    process.exit(1);
  }
  throw err;
}
