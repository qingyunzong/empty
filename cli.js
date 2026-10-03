#!/usr/bin/env node
'use strict';

const { Store } = require('./src/store');
const { cancelSlip } = require('./src/ledger');

function usage() {
  return [
    'usage:',
    '  node cli.js --dir D tx \'{"gets":["k"],"puts":{"k":{}},"cancel":"slipId"}\'',
    '  node cli.js --dir D get [KEY] [--at V]',
  ].join('\n');
}

function parseArgs(argv) {
  const opts = { positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dir') opts.dir = argv[++i];
    else if (arg === '--at') opts.at = Number(argv[++i]);
    else opts.positional.push(arg);
  }
  return opts;
}

async function cmdTx(store, specRaw) {
  let spec;
  try {
    spec = JSON.parse(specRaw);
  } catch {
    throw Object.assign(new Error('tx argument is not valid JSON'), { code: 'E_BAD_REQUEST' });
  }
  if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) {
    throw Object.assign(new Error('tx spec must be a JSON object'), { code: 'E_BAD_REQUEST' });
  }
  const tx = await store.begin();
  for (const key of spec.gets || []) await tx.get(key);
  for (const [key, value] of Object.entries(spec.puts || {})) tx.put(key, value);
  if (spec.cancel !== undefined) await cancelSlip(tx, spec.cancel);
  const { version } = await tx.commit();
  process.stdout.write(JSON.stringify({ version }) + '\n');
}

async function cmdGet(store, key, at) {
  const version = at !== undefined ? at : await store.currentVersion();
  if (key === undefined) {
    const state = await store.stateAt(version);
    process.stdout.write(JSON.stringify({ version, state }) + '\n');
    return;
  }
  const value = await store.getAt(key, version);
  if (value === undefined) {
    throw Object.assign(new Error(`key "${key}" not found at version ${version}`), { code: 'E_NOT_FOUND' });
  }
  process.stdout.write(JSON.stringify({ version, key, value }) + '\n');
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.dir) {
    throw Object.assign(new Error(usage()), { code: 'E_USAGE' });
  }
  const [cmd, ...rest] = opts.positional;
  const store = new Store(opts.dir);
  if (cmd === 'tx') {
    await cmdTx(store, rest[0]);
  } else if (cmd === 'get') {
    await cmdGet(store, rest[0], opts.at);
  } else {
    throw Object.assign(new Error(usage()), { code: 'E_USAGE' });
  }
}

main().catch((err) => {
  const code = typeof err.code === 'string' ? err.code : 'E_INTERNAL';
  process.stdout.write(JSON.stringify({ error: code }) + '\n');
  process.exitCode = 1;
});
