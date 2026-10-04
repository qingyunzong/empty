#!/usr/bin/env node
'use strict';
// Defect recall CLI: load / recall / revoke / prove / audit (offline, stdlib only).

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { Store, StoreError } from './src/store.js';

const EXIT_CODES = { E_EPOCH: 2, E_DUP: 3, E_PROOF: 4 };

const USAGE = `usage:
  node cli.js [--store <path>] load <batch.json>
  node cli.js [--store <path>] load --delete <batchId>
  node cli.js [--store <path>] recall [--phrase <text>] [--defect-code <code>] [--batch-code <code>] [--name <id>]
  node cli.js [--store <path>] revoke <recallId>
  node cli.js [--store <path>] prove <recallId>
  node cli.js [--store <path>] audit`;

function parseFlags(args) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      flags[args[i].slice(2)] = args[++i];
    } else {
      rest.push(args[i]);
    }
  }
  return { flags, rest };
}

function main() {
  const args = process.argv.slice(2);
  let storePath = 'recall-store.json';
  const si = args.indexOf('--store');
  if (si >= 0) {
    storePath = args[si + 1];
    args.splice(si, 2);
  }
  const cmd = args.shift();
  if (!cmd) {
    console.error(USAGE);
    process.exit(1);
  }
  const store = existsSync(storePath)
    ? Store.fromJSON(JSON.parse(readFileSync(storePath, 'utf8')))
    : new Store();
  const save = () => writeFileSync(storePath, JSON.stringify(store.toJSON()));
  const out = (obj) => console.log(JSON.stringify(obj, null, 2));

  switch (cmd) {
    case 'load': {
      const { flags, rest } = parseFlags(args);
      if (flags.delete !== undefined) {
        out(store.deleteBatch(flags.delete));
      } else {
        const batch = JSON.parse(readFileSync(rest[0], 'utf8'));
        out(store.loadBatch(batch));
      }
      save();
      break;
    }
    case 'recall': {
      const { flags } = parseFlags(args);
      const { rec, created } = store.recall(
        { phrase: flags.phrase, defectCode: flags['defect-code'], batchCode: flags['batch-code'] },
        flags.name);
      save();
      out({
        recallId: rec.id,
        created,
        revoked: rec.revoked,
        epoch: rec.epoch,
        hits: rec.hits,
        certificate: {
          queryHash: rec.queryHash,
          hitsHash: rec.hitsHash,
          epoch: rec.epoch,
          recallHash: rec.recallHash,
        },
      });
      break;
    }
    case 'revoke': {
      const { rest } = parseFlags(args);
      out(store.revoke(rest[0]));
      save();
      break;
    }
    case 'prove': {
      const { rest } = parseFlags(args);
      out(store.prove(rest[0]));
      break;
    }
    case 'audit': {
      const report = store.auditReport();
      out(report);
      if (!report.ok) {
        throw new StoreError('E_PROOF', 'audit chain integrity check failed');
      }
      break;
    }
    default:
      console.error(USAGE);
      process.exit(1);
  }
}

try {
  main();
} catch (err) {
  if (err instanceof StoreError || (err && err.code && EXIT_CODES[err.code])) {
    console.error(`error: ${err.code}: ${err.message}`);
    process.exit(EXIT_CODES[err.code] ?? 1);
  }
  console.error('error:', err.message);
  process.exit(1);
}
