#!/usr/bin/env node
// CLI for the transaction correction/cancellation history store.
//
// Commands:
//   put         --tx ID --price N --qty N --author NAME
//   replace     --tx ID [--price N] [--qty N] [--base HASH] --author NAME
//   cancel      --tx ID [--base HASH] --author NAME
//   resolve     --tx ID [--price N] [--qty N] [--cancel] --author NAME
//   materialize --tx ID
//   history     [--tx ID]
//   verify      [--rebuild]
//
// Common: --dir PATH (store directory, default ./txdata)
// Output: JSON on stdout. Exit codes: 0 ok, 1 error, 2 conflict.
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Store } from './src/store.js';
import { Engine } from './src/engine.js';

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        args[key] = true;
      } else {
        args[key] = next;
        i++;
      }
    } else {
      args._.push(a);
    }
  }
  return args;
}

function num(v) {
  if (v === undefined || v === true) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`invalid number: ${v}`);
  return n;
}

export function exitCodeFor(result) {
  const conflict =
    result.status === 'CONFLICT' ||
    result.status === 'UNRESOLVED_CONFLICT' ||
    result.error === 'UNRESOLVED_CONFLICT';
  if (conflict) return 2;
  return result.ok === false ? 1 : 0;
}

// Execute one CLI invocation; returns the result object (JSON-serializable).
export function execute(argv) {
  try {
    const args = parseArgs(argv);
    const cmd = args._[0];
    const dir = typeof args.dir === 'string' ? args.dir : './txdata';
    const store = new Store(dir);
    const engine = new Engine(store);

    switch (cmd) {
      case 'put':
        return engine.put({ txId: args.tx, price: num(args.price), qty: num(args.qty), author: String(args.author || 'unknown') });
      case 'replace':
        return engine.replace({
          txId: args.tx,
          base: args.base === true ? undefined : args.base,
          price: num(args.price),
          qty: num(args.qty),
          author: String(args.author || 'unknown'),
        });
      case 'cancel':
        return engine.cancel({ txId: args.tx, base: args.base === true ? undefined : args.base, author: String(args.author || 'unknown') });
      case 'resolve':
        return engine.resolve({
          txId: args.tx,
          price: num(args.price),
          qty: num(args.qty),
          cancel: !!args.cancel,
          author: String(args.author || 'unknown'),
        });
      case 'materialize':
        return engine.materialize({ txId: args.tx });
      case 'history':
        return engine.history(args.tx ? { txId: args.tx } : {});
      case 'verify':
        return store.verify({ rebuild: !!args.rebuild });
      default:
        return { ok: false, error: 'USAGE', usage: 'put|replace|cancel|resolve|materialize|history|verify (see cli.js header)' };
    }
  } catch (err) {
    return { ok: false, error: 'EXCEPTION', message: String((err && err.message) || err) };
  }
}

const isMain =
  process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const result = execute(process.argv.slice(2));
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = exitCodeFor(result);
}
