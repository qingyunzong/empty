#!/usr/bin/env node
// JSONL replay CLI. Reads commands from a file argument or stdin, one JSON
// object per line, prints one result line per command.
//
// Commands:
//   {"op":"observe","id":"e1","ts":100,"node":"dev1"}  -> OK | INVALID_INPUT
//   {"op":"link","a":"e1","b":"e2","kind":"cause"}     -> OK | INVALID_INPUT
//   {"op":"checkpoint"}                                -> OK
//   {"op":"rollback","k":2}                            -> OK | ROLLBACK_RANGE | INVALID_INPUT
//   {"op":"query","a":"e1","b":"e2"}                   -> REACHABLE | NOT_REACHABLE | CONCURRENT | UNDECIDED | INVALID_INPUT
//   {"op":"scc"}                                       -> JSON array of sorted components (size > 1)

import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { EventBus, InvalidInputError } from '../src/eventbus.js';

export function runLine(bus, line) {
  let record;
  try {
    record = JSON.parse(line);
  } catch {
    return 'INVALID_INPUT';
  }
  if (record === null || typeof record !== 'object' || typeof record.op !== 'string') {
    return 'INVALID_INPUT';
  }
  try {
    switch (record.op) {
      case 'observe':
        return bus.observe(record.id, record.ts, record.node);
      case 'link':
        return bus.link(record.a, record.b, record.kind);
      case 'checkpoint':
        return bus.checkpoint();
      case 'rollback':
        return bus.rollback(record.k);
      case 'query':
        return bus.query(record.a, record.b);
      case 'scc':
        return JSON.stringify(bus.scc());
      default:
        return 'INVALID_INPUT';
    }
  } catch (err) {
    if (err instanceof InvalidInputError) return 'INVALID_INPUT';
    throw err;
  }
}

async function main() {
  const file = process.argv[2];
  const bus = new EventBus();
  const stream = file ? createReadStream(file, 'utf8') : process.stdin;
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    process.stdout.write(runLine(bus, trimmed) + '\n');
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === new URL('file://' + process.argv[1]).href;
if (invokedDirectly) {
  main().catch((err) => {
    process.stderr.write(String(err && err.message ? err.message : err) + '\n');
    process.exitCode = 1;
  });
}
