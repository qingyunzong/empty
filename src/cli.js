#!/usr/bin/env node
// Usage: node src/cli.js batches --in events.jsonl
// Reads newline-delimited JSON events, writes one JSON action per line and a
// final CERTIFICATE line. Use `--in -` (or omit) to read from stdin.

import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { createEngine } from './engine.js';

export function parseArgs(argv) {
  const rest = [...argv];
  const command = rest.shift() ?? null;
  let input = '-';
  while (rest.length > 0) {
    const flag = rest.shift();
    if (flag === '--in') {
      input = rest.shift();
      if (input === undefined) throw new Error('--in requires a file path (or - for stdin)');
    } else {
      throw new Error(`unknown argument: ${flag}`);
    }
  }
  if (command !== 'batches') {
    throw new Error('usage: node src/cli.js batches --in events.jsonl');
  }
  return { command, input };
}

export async function runCli(argv, { stdin, stdout, stderr } = {}) {
  const inStream = stdin ?? process.stdin;
  const outStream = stdout ?? process.stdout;
  const errStream = stderr ?? process.stderr;

  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    errStream.write(`${err.message}\n`);
    return 2;
  }

  const engine = createEngine();
  const stream = args.input === '-' ? inStream : createReadStream(args.input, 'utf8');
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  let lineNo = 0;
  for await (const line of rl) {
    lineNo += 1;
    const trimmed = line.trim();
    if (!trimmed) continue;
    let event;
    try {
      event = JSON.parse(trimmed);
    } catch {
      outStream.write(`${JSON.stringify({ action: 'ERROR', code: 'INVALID_JSON', line: lineNo })}\n`);
      continue;
    }
    for (const action of engine.process(event)) {
      outStream.write(`${JSON.stringify(action)}\n`);
    }
  }
  outStream.write(`${JSON.stringify(engine.certificate())}\n`);
  return 0;
}

const isMain = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  process.exitCode = await runCli(process.argv.slice(2));
}
