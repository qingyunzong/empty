#!/usr/bin/env node
import fs from 'node:fs';
import { replay } from './src/engine.js';
import { appendRecords, recoverRecords } from './src/wal.js';

function parseJsonl(text) {
  const events = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (line.length === 0) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      throw new Error(`invalid JSON on input line ${i + 1}`);
    }
  }
  return events;
}

function parseArgs(rest) {
  const opts = {};
  for (let i = 0; i < rest.length; i += 1) {
    const key = rest[i];
    if (!key.startsWith('--')) throw new Error(`unexpected argument: ${key}`);
    const name = key.slice(2);
    if (i + 1 >= rest.length) throw new Error(`missing value for ${key}`);
    opts[name] = rest[i + 1];
    i += 1;
  }
  return opts;
}

function printJson(value) {
  fs.writeSync(1, `${JSON.stringify(value, null, 2)}\n`);
}

async function cmdRun(opts) {
  if (!opts.log) throw new Error('--log is required');
  const input = opts.input ? fs.readFileSync(opts.input, 'utf8') : await readStdin();
  const newEvents = parseJsonl(input);
  const { records: logged, truncated, truncatedBytes } = recoverRecords(opts.log);
  const engine = replay([...logged, ...newEvents]);
  appendRecords(opts.log, newEvents);
  const fresh = new Set(newEvents);
  const journal = engine.journal.filter((record) => fresh.has(record.event));
  printJson({ recovered: { truncated, truncatedBytes }, snapshot: engine.snapshot(), journal });
}

function cmdSnapshot(opts) {
  if (!opts.log) throw new Error('--log is required');
  const { records, truncated, truncatedBytes } = recoverRecords(opts.log);
  const engine = replay(records);
  printJson({ recovered: { truncated, truncatedBytes }, snapshot: engine.snapshot() });
}

function cmdReplay(opts) {
  if (!opts.log) throw new Error('--log is required');
  const prefix = opts.prefix === undefined ? Number.POSITIVE_INFINITY : Number(opts.prefix);
  if (!Number.isInteger(prefix) || prefix < 0) throw new Error('--prefix must be a non-negative integer');
  const { records, truncated, truncatedBytes } = recoverRecords(opts.log);
  const engine = replay(records, prefix);
  printJson({ recovered: { truncated, truncatedBytes }, prefix, snapshot: engine.snapshot(), journal: engine.journal });
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

async function main(argv) {
  const [command, ...rest] = argv;
  const opts = parseArgs(rest);
  switch (command) {
    case 'run':
      await cmdRun(opts);
      break;
    case 'snapshot':
      cmdSnapshot(opts);
      break;
    case 'replay':
      cmdReplay(opts);
      break;
    default:
      throw new Error(`unknown command: ${command ?? '(none)'}; expected run|snapshot|replay`);
  }
}

main(process.argv.slice(2)).catch((err) => {
  fs.writeSync(2, `error: ${err.message}\n`);
  process.exit(4);
});
