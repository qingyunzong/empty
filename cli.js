#!/usr/bin/env node
import { TradingEngine, TradingError } from './src/engine.js';

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  const [workdir, eventArg] = process.argv.slice(2);
  if (!workdir || !eventArg) {
    throw new TradingError('USAGE', 'usage: node cli.js <workdir> <event-json | "-" for stdin>');
  }
  const text = eventArg === '-' ? await readStdin() : eventArg;
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new TradingError('INVALID_JSON', 'event argument is not valid JSON');
  }
  const engine = await TradingEngine.open(workdir);
  const certificate = await engine.submit(raw);
  process.stdout.write(JSON.stringify(certificate, null, 2) + '\n');
}

main().catch((err) => {
  const code = err instanceof TradingError ? err.code : 'INTERNAL_ERROR';
  const message = err instanceof Error ? err.message : String(err);
  process.stdout.write(JSON.stringify({ error: code, message }) + '\n');
  process.exit(1);
});
