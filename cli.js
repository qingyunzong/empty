#!/usr/bin/env node
// kv-merge CLI: commit / read / export / import / check / replay
//
//   node cli.js --dir D [--site S] commit --read k1 --write k2=v2 [--write k3=v3]
//   node cli.js --dir D read <key> [--at '{"A":2}']
//   node cli.js --dir D export [--out seg.jsonl] [--since '{"A":1}']
//   node cli.js --dir D import <seg.jsonl>
//   node cli.js --dir D check
//   node cli.js --dir D replay
//
// Exit codes: 0 ok / SERIALIZABLE; 3 NON_SERIALIZABLE; 4 import saw CORRUPT
// entries (valid entries still imported); 2 usage/IO error; 5 replay mismatch.

import fs from 'node:fs';
import path from 'node:path';
import { Store } from './src/store.js';

function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        opts[key] = true;
      } else {
        if (opts[key] === undefined) opts[key] = next;
        else if (Array.isArray(opts[key])) opts[key].push(next);
        else opts[key] = [opts[key], next];
        i++;
      }
    } else {
      opts._.push(a);
    }
  }
  return opts;
}

const asList = (v) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

function fail(msg) {
  console.error(`error: ${msg}`);
  process.exit(2);
}

const opts = parseArgs(process.argv.slice(2));
const cmd = opts._[0];
if (!cmd) {
  console.error('usage: node cli.js --dir D [--site S] <commit|read|export|import|check|replay> ...');
  process.exit(2);
}
const dir = opts.dir ?? './data';
const site = opts.site ?? path.basename(path.resolve(dir));
const store = Store.open(dir, site);

switch (cmd) {
  case 'commit': {
    const reads = asList(opts.read);
    const writes = {};
    for (const pair of asList(opts.write)) {
      const eq = pair.indexOf('=');
      if (eq <= 0) fail(`bad --write "${pair}", expected k=v`);
      writes[pair.slice(0, eq)] = pair.slice(eq + 1);
    }
    if (reads.length === 0 && Object.keys(writes).length === 0) {
      fail('commit needs at least one --read or --write');
    }
    const txn = store.commit({ reads, writes });
    console.log(JSON.stringify(txn, null, 2));
    break;
  }
  case 'read': {
    const key = opts._[1];
    if (!key) fail('read needs a key');
    const at = opts.at ? JSON.parse(opts.at) : undefined;
    console.log(JSON.stringify(store.read(key, { at })));
    break;
  }
  case 'export': {
    const since = opts.since ? JSON.parse(opts.since) : undefined;
    const text = store.exportSegment({ since });
    if (opts.out) {
      fs.writeFileSync(opts.out, text);
      console.log(`exported to ${opts.out}`);
    } else {
      process.stdout.write(text);
    }
    break;
  }
  case 'import': {
    const file = opts._[1];
    if (!file) fail('import needs a segment file');
    const report = store.importSegment(fs.readFileSync(file, 'utf8'));
    console.log(JSON.stringify(report));
    if (report.status === 'CORRUPT') {
      console.error('CORRUPT: some entries were skipped');
      process.exit(4);
    }
    break;
  }
  case 'check': {
    const res = store.check();
    if (res.serializable) {
      console.log('SERIALIZABLE');
      console.log(`order: ${res.order.join(' -> ') || '(empty)'}`);
      console.log(`replay consistent with merged state: ${res.consistent}`);
      process.exit(res.consistent ? 0 : 5);
    } else {
      console.log('NON_SERIALIZABLE');
      if (res.cycle) console.log(`conflict cycle: ${res.cycle.join(' -> ')}`);
      if (res.reason) console.log(`reason: ${res.reason}`);
      process.exit(3);
    }
    break;
  }
  case 'replay': {
    const res = store.check();
    if (!res.serializable) {
      console.log('NON_SERIALIZABLE: no equivalent serial history to replay');
      if (res.cycle) console.log(`conflict cycle: ${res.cycle.join(' -> ')}`);
      process.exit(3);
    }
    console.log(`order: ${res.order.join(' -> ') || '(empty)'}`);
    console.log(`state: ${JSON.stringify(res.replayed)}`);
    console.log(res.consistent ? 'CONSISTENT with merged state' : 'MISMATCH with merged state');
    process.exit(res.consistent ? 0 : 5);
    break;
  }
  default:
    fail(`unknown command: ${cmd}`);
}
