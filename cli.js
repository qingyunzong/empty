#!/usr/bin/env node
import fs from 'node:fs';
import { Store } from './src/store.js';
import { StoreError, E_IO } from './src/errors.js';

const USAGE = `usage:
  node cli.js ingest  <dir> [--event '{"seq":1,"ts":1000,"code":"ALARM","device":"D1}']... [--file events.jsonl]
  node cli.js freeze  <dir>
  node cli.js compact <dir>
  node cli.js query   <dir> (--device D --timeout-code C [--window 5] | --phrase ALARM,ACK,RESET)
  node cli.js recover <dir>
errors: E_IO (io/manifest), E_SEQ (sequence violation/conflict), E_RANGE (invalid range/argument)`;

function parseFlags(args) {
  const flags = new Map();
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const val = args[i + 1];
      if (val === undefined || val.startsWith('--')) throw new Error(`missing value for --${key}`);
      if (flags.has(key)) flags.get(key).push(val);
      else flags.set(key, [val]);
      i++;
    } else {
      positional.push(a);
    }
  }
  return { flags, positional };
}

const flag1 = (flags, k) => flags.get(k)?.[0];
const flagAll = (flags, k) => flags.get(k) ?? [];

function readEvents(flags) {
  const events = [];
  for (const raw of flagAll(flags, 'event')) events.push(JSON.parse(raw));
  const file = flag1(flags, 'file');
  if (file) {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (line.trim()) events.push(JSON.parse(line));
    }
  }
  return events;
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd) throw new Error(USAGE);
  const { flags, positional } = parseFlags(rest);
  const dir = positional[0];
  if (!dir) throw new Error(USAGE);

  let result;
  switch (cmd) {
    case 'ingest': {
      const events = readEvents(flags);
      result = Store.open(dir, { create: true }).ingest(events);
      break;
    }
    case 'freeze':
      result = Store.open(dir, { create: true }).freeze();
      break;
    case 'compact':
      result = Store.open(dir).compact();
      break;
    case 'query': {
      const store = Store.open(dir);
      const phrase = flag1(flags, 'phrase');
      if (phrase !== undefined) {
        result = store.queryPhrase(phrase.split(',').filter((s) => s.length > 0));
      } else {
        const windowRaw = flag1(flags, 'window');
        result = store.queryCooccur({
          device: flag1(flags, 'device'),
          timeoutCode: flag1(flags, 'timeout-code'),
          window: windowRaw === undefined ? 5 : Number(windowRaw),
        });
      }
      break;
    }
    case 'recover':
      result = Store.recover(dir);
      break;
    default:
      throw new Error(USAGE);
  }
  process.stdout.write(`${JSON.stringify({ ok: true, result })}\n`);
}

try {
  main();
} catch (err) {
  if (err instanceof StoreError) {
    process.stderr.write(`${JSON.stringify({ ok: false, error: { code: err.code, message: err.message } })}\n`);
    process.exit(1);
  }
  if (err && typeof err.code === 'string' && /^(ENOENT|EACCES|EPERM|EMFILE|ENOSPC|ENOTDIR|EISDIR)/.test(err.code)) {
    process.stderr.write(`${JSON.stringify({ ok: false, error: { code: E_IO, message: err.message } })}\n`);
    process.exit(1);
  }
  process.stderr.write(`${JSON.stringify({ ok: false, error: { code: 'E_USAGE', message: String(err.message || err) } })}\n`);
  process.exit(2);
}
