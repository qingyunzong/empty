#!/usr/bin/env node
'use strict';

const fs = require('fs');
const { Store, StoreError } = require('../src/store');

function fail(err) {
  const code = err instanceof StoreError ? err.code : 'INTERNAL';
  fs.writeSync(2, JSON.stringify({ error: err.message, code }) + '\n');
  process.exit(1);
}

function usage() {
  fs.writeSync(2, JSON.stringify({
    error: 'usage: cli.js <add|delete|restore|query|decode> <dir> [args]',
    code: 'USAGE',
  }) + '\n');
  process.exit(1);
}

function out(obj) {
  fs.writeSync(1, JSON.stringify(obj, null, 2) + '\n');
}

async function readInput(file) {
  if (file !== '-') return fs.readFileSync(file, 'utf8');
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

function parseJsonl(text) {
  const records = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      throw new StoreError('CORRUPT_JSON', `invalid JSON on line ${i + 1}`);
    }
  }
  return records;
}

async function main() {
  const [cmd, dir, ...rest] = process.argv.slice(2);
  if (!cmd || !dir) usage();
  try {
    switch (cmd) {
      case 'add': {
        const file = rest[0];
        if (!file) usage();
        const records = parseJsonl(await readInput(file)); // validate before touching the store
        const store = Store.open(dir);
        const added = store.addRecords(records);
        out({ added, indexVersion: store.indexVersion });
        break;
      }
      case 'delete': {
        const id = rest[0];
        if (!id) usage();
        const store = Store.open(dir);
        const changed = store.delete(id);
        out({ deleted: id, changed, indexVersion: store.indexVersion });
        break;
      }
      case 'restore': {
        const id = rest[0];
        if (!id) usage();
        const store = Store.open(dir);
        const changed = store.restore(id);
        out({ restored: id, changed, indexVersion: store.indexVersion });
        break;
      }
      case 'query': {
        let phrase;
        let slop;
        for (let i = 0; i < rest.length; i++) {
          if (rest[i] === '--phrase') phrase = rest[++i];
          else if (rest[i] === '--slop') {
            const raw = rest[++i];
            if (!/^\d+$/.test(raw || '')) {
              throw new StoreError('INVALID_SLOP', `invalid slop: ${raw}`);
            }
            slop = Number(raw);
          } else usage();
        }
        if (phrase === undefined) usage();
        const store = Store.open(dir);
        const result = store.query(phrase, slop === undefined ? {} : { slop });
        out(result);
        break;
      }
      case 'decode': {
        const store = Store.open(dir);
        const decoded = store.decodeCurrentSegment();
        out(decoded);
        break;
      }
      default:
        usage();
    }
  } catch (err) {
    fail(err);
  }
}

main().catch(fail);
