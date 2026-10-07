#!/usr/bin/env node
import fs from 'node:fs';
import { Store, CrashInjected } from './store.js';

const USAGE = `usage:
  node src/cli.js append  --dir DIR [--file EVENTS.json|jsonl] [--crash=before-append|after-append]
  node src/cli.js query   --dir DIR --device ID --from TS --to TS
  node src/cli.js compact --dir DIR

events: {"id","device","ts","state"} with state in {up,down};
ts is epoch seconds or an ISO-8601 string. exit code 75 = injected crash.`;

function parseOptions(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const eq = arg.indexOf('=');
    if (eq !== -1) opts[arg.slice(2, eq)] = arg.slice(eq + 1);
    else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) opts[arg.slice(2)] = argv[(i += 1)];
    else opts[arg.slice(2)] = true;
  }
  return opts;
}

function parseTs(value) {
  if (typeof value === 'number') return value;
  if (/^\d+$/.test(value)) return Number(value);
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw new Error(`invalid timestamp: ${value}`);
  return Math.floor(ms / 1000);
}

function normalizeEvent(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('event must be an object');
  const { id, device, ts, state } = raw;
  if (id === undefined || id === null) throw new Error('event missing id');
  if (!device) throw new Error('event missing device');
  if (state !== 'up' && state !== 'down') throw new Error(`invalid state: ${state}`);
  return { id: String(id), device: String(device), ts: parseTs(ts), state };
}

function readEvents(opts) {
  const text = opts.file ? fs.readFileSync(opts.file, 'utf8') : fs.readFileSync(0, 'utf8');
  const trimmed = text.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed);
    const list = Array.isArray(parsed) ? parsed : [parsed];
    return list.map(normalizeEvent);
  } catch {
    return trimmed.split('\n').filter(Boolean).map((line) => normalizeEvent(JSON.parse(line)));
  }
}

function required(opts, name) {
  if (opts[name] === undefined || opts[name] === true) {
    throw new Error(`missing required option --${name}`);
  }
  return opts[name];
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const opts = parseOptions(rest);
  const dir = opts.dir ?? './data';
  switch (cmd) {
    case 'append': {
      const events = readEvents(opts);
      const store = Store.open(dir);
      try {
        const appended = store.appendBatch(events, { crash: opts.crash === true ? undefined : opts.crash });
        console.log(JSON.stringify({ appended, offset: store.offset }));
      } catch (err) {
        if (err instanceof CrashInjected) {
          fs.writeSync(2, `${err.message}\n`);
          process.exit(75);
        }
        throw err;
      }
      break;
    }
    case 'query': {
      const store = Store.open(dir);
      const device = String(required(opts, 'device'));
      const from = parseTs(required(opts, 'from'));
      const to = parseTs(required(opts, 'to'));
      for (const row of store.query(device, from, to)) {
        console.log(JSON.stringify(row));
      }
      break;
    }
    case 'compact': {
      const store = Store.open(dir);
      const result = store.compact();
      console.log(JSON.stringify({ compacted: true, ...result }));
      break;
    }
    default:
      console.error(USAGE);
      process.exit(cmd ? 2 : 0);
  }
}

try {
  main();
} catch (err) {
  fs.writeSync(2, `error: ${err.message}\n`);
  process.exit(1);
}
