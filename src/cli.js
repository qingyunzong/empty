#!/usr/bin/env node
/**
 * cli.js — replay a JSONL op stream against the event bus.
 *
 * Usage:
 *   node src/cli.js <input.jsonl>   # read ops from file
 *   node src/cli.js -               # read ops from stdin (also default)
 *
 * Input, one JSON object per line:
 *   {"op":"observe","id":"e1","ts":100,"node":"press-1"}
 *   {"op":"link","a":"e1","b":"e2","kind":"causes"}     # kind optional
 *   {"op":"checkpoint"}
 *   {"op":"rollback","k":2}
 *   {"op":"query","a":"e1","b":"e2"}
 *   {"op":"scc"}
 *
 * Output, one JSON object per input line:
 *   {"line":1,"op":"observe","ok":true}
 *   {"line":5,"op":"query","a":"e1","b":"e2","ok":true,"result":"REACHABLE"}
 *   {"line":6,"op":"scc","ok":true,"components":[["A","B","C"]]}
 *   {"line":7,"op":"rollback","k":9,"ok":false,"error":"ROLLBACK_RANGE","message":"..."}
 *
 * Per-line errors (INVALID_INPUT / ROLLBACK_RANGE) do not abort the replay.
 * Exit code is 0 unless the input itself cannot be read.
 */
import { readFileSync } from 'node:fs';
import process from 'node:process';
import { EventBus, BusError, INVALID_INPUT } from './eventbus.js';

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function processOp(bus, obj) {
  const op = obj?.op;
  switch (op) {
    case 'observe':
      bus.observe(obj);
      return { ok: true };
    case 'link':
      bus.link(obj);
      return { ok: true };
    case 'checkpoint':
      return { ok: true, layer: bus.checkpoint() };
    case 'rollback':
      bus.rollback(obj?.k);
      return { ok: true };
    case 'query':
      return { ok: true, result: bus.query(obj?.a, obj?.b) };
    case 'scc':
      return { ok: true, components: bus.scc() };
    default:
      throw new BusError(INVALID_INPUT, `unknown op: ${JSON.stringify(op ?? null)}`);
  }
}

export function replay(input) {
  const bus = new EventBus();
  const results = [];
  const lines = String(input).split(/\r?\n/);
  lines.forEach((raw, index) => {
    if (raw.trim() === '') return;
    const record = { line: index + 1 };
    let obj = null;
    try {
      obj = JSON.parse(raw);
      record.op = obj?.op ?? null;
      Object.assign(record, processOp(bus, obj));
    } catch (err) {
      if (record.op === undefined) record.op = null;
      record.ok = false;
      record.error = err instanceof BusError ? err.code : INVALID_INPUT;
      record.message = err instanceof Error ? err.message : String(err);
    }
    results.push(record);
  });
  return results;
}

async function main(argv) {
  const args = argv.slice(2);
  let input;
  try {
    input = args.length === 0 || args[0] === '-' ? await readStdin() : readFileSync(args[0], 'utf8');
  } catch (err) {
    process.stderr.write(`cli: cannot read input: ${err.message}\n`);
    process.exitCode = 2;
    return;
  }
  for (const record of replay(input)) {
    process.stdout.write(`${JSON.stringify(record)}\n`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main(process.argv);
}
