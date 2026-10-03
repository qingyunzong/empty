#!/usr/bin/env node
'use strict';

const { Store, StoreError } = require('./lib');

function fail(code) {
  process.stderr.write(JSON.stringify({ error: code }) + '\n');
  process.exit(1);
}

function parseValue(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function main() {
  const [, , cmd, log, ...args] = process.argv;
  if (!cmd || !log) fail('ERR_USAGE');
  const store = new Store(log);
  let out;
  switch (cmd) {
    case 'append':
      out = store.appendObs(args[0], Number(args[1]), parseValue(args[2]));
      break;
    case 'flag':
      out = store.flag(args[0], args[1], args[2]);
      break;
    case 'invalidate':
      out = store.invalidate(args[0]);
      break;
    case 'current':
      out = store.current(args[0]);
      break;
    case 'history':
      out = store.history(args[0]);
      break;
    case 'verify':
      out = store.verify();
      break;
    case 'rebuild':
      out = store.rebuild();
      break;
    default:
      fail('ERR_USAGE');
  }
  process.stdout.write(JSON.stringify(out) + '\n');
}

try {
  main();
} catch (err) {
  if (err instanceof StoreError) fail(err.code);
  throw err;
}
