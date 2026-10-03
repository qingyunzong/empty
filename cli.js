#!/usr/bin/env node
import { History, HistError } from './src/history.js';
import { Store } from './src/store.js';

function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  const opts = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = rest[i + 1];
      if (next === undefined || next.startsWith('--')) opts[key] = true;
      else {
        opts[key] = next;
        i++;
      }
    }
  }
  return { cmd, opts };
}

function fail(code, message, exitCode = 1, extra = {}) {
  throw new HistError(code, message, exitCode, extra);
}

function req(opts, name) {
  if (opts[name] === undefined || opts[name] === true) fail('MISSING_ARG', `missing --${name}`);
  return opts[name];
}

function num(opts, name, { required = false } = {}) {
  if (opts[name] === undefined) {
    if (required) fail('MISSING_ARG', `missing --${name}`);
    return undefined;
  }
  const v = Number(opts[name]);
  if (!Number.isFinite(v) || v <= 0) fail('BAD_NUMBER', `--${name} must be a positive number`);
  return v;
}

const { cmd, opts } = parseArgs(process.argv.slice(2));
const storeDir = typeof opts.store === 'string' ? opts.store : '.tradehist';
const print = (obj) => process.stdout.write(JSON.stringify(obj, null, 2) + '\n');

try {
  let out;
  let exitCode = 0;
  switch (cmd) {
    case 'put': {
      const h = new History(storeDir);
      out = h.put({
        tradeId: req(opts, 'id'),
        price: num(opts, 'price', { required: true }),
        quantity: num(opts, 'qty', { required: true }),
        author: opts.author ?? 'anon',
      });
      break;
    }
    case 'replace': {
      const h = new History(storeDir);
      out = h.replace({
        tradeId: req(opts, 'id'),
        base: typeof opts.base === 'string' ? opts.base : null,
        price: num(opts, 'price'),
        quantity: num(opts, 'qty'),
        author: opts.author ?? 'anon',
      });
      break;
    }
    case 'cancel': {
      const h = new History(storeDir);
      out = h.cancel({
        tradeId: req(opts, 'id'),
        base: typeof opts.base === 'string' ? opts.base : null,
        author: opts.author ?? 'anon',
      });
      break;
    }
    case 'resolve': {
      const h = new History(storeDir);
      out = h.resolve({
        tradeId: req(opts, 'id'),
        winner: typeof opts.winner === 'string' ? opts.winner : null,
        price: num(opts, 'price'),
        quantity: num(opts, 'qty'),
        author: opts.author ?? 'anon',
      });
      break;
    }
    case 'materialize': {
      const h = new History(storeDir);
      out = h.materialize(req(opts, 'id'));
      break;
    }
    case 'history': {
      const h = new History(storeDir);
      out = h.history(req(opts, 'id'));
      break;
    }
    case 'verify': {
      const s = new Store(storeDir);
      out = s.verify({ rebuild: opts.rebuild === true });
      if (!out.ok) exitCode = 1;
      break;
    }
    default:
      fail('UNKNOWN_COMMAND', `unknown command: ${cmd ?? '(none)'}. Use put|replace|cancel|resolve|materialize|history|verify`);
  }
  print({ ok: exitCode === 0, ...out });
  process.exitCode = exitCode;
} catch (e) {
  if (e instanceof HistError) {
    print({ ok: false, error: { code: e.code, message: e.message, ...e.extra } });
    process.exitCode = e.exitCode;
  } else {
    print({ ok: false, error: { code: 'INTERNAL', message: e.message } });
    process.exitCode = 1;
  }
}
