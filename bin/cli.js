#!/usr/bin/env node
'use strict';

const { parseArgs } = require('node:util');
const { Store } = require('../src/store.js');

function toNumber(value, name) {
  const num = Number(value);
  if (!Number.isFinite(num)) throw new Error(`--${name} must be a number, got: ${value}`);
  return num;
}

const COMMANDS = {
  freeze: {
    options: ['id', 'parent', 'amount', 'quota', 'policy'],
    run(store, v) {
      return store.freeze({
        id: v.id,
        parentId: v.parent === undefined ? null : v.parent,
        amount: toNumber(v.amount, 'amount'),
        quota: toNumber(v.quota, 'quota'),
        policyText: v.policy === undefined ? '' : v.policy,
      });
    },
  },
  expire: {
    options: ['id'],
    run: (store, v) => store.expire(v.id),
  },
  restore: {
    options: ['id'],
    run: (store, v) => store.restore(v.id),
  },
  purge: {
    options: [],
    run: (store) => store.purge(),
  },
  update: {
    options: ['id', 'version', 'policy', 'quota', 'amount'],
    run(store, v) {
      const patch = {};
      if (v.policy !== undefined) patch.policyText = v.policy;
      if (v.quota !== undefined) patch.quota = toNumber(v.quota, 'quota');
      if (v.amount !== undefined) patch.amount = toNumber(v.amount, 'amount');
      return store.update(v.id, toNumber(v.version, 'version'), patch);
    },
  },
  query: {
    options: ['phrase'],
    run: (store, v) => ({ hits: store.query(v.phrase) }),
  },
  get: {
    options: ['id'],
    run: (store, v) => store.get(v.id),
  },
  balance: {
    options: ['id'],
    run: (store, v) => ({ id: v.id, balance: store.balance(v.id), used: store.used(v.id) }),
  },
};

function extractDataDir(argv) {
  const rest = [];
  let dataDir = './quota-data';
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--data-dir') {
      dataDir = argv[i + 1];
      i += 1;
    } else if (arg.startsWith('--data-dir=')) {
      dataDir = arg.slice('--data-dir='.length);
    } else {
      rest.push(arg);
    }
  }
  return { dataDir, rest };
}

function main(argv) {
  const { dataDir, rest } = extractDataDir(argv);
  const [command, ...commandArgs] = rest;
  const spec = COMMANDS[command];
  if (spec === undefined) {
    const names = Object.keys(COMMANDS).join(', ');
    throw new Error(`unknown command: ${command === undefined ? '(none)' : command}. available: ${names}`);
  }

  const parsed = parseArgs({
    args: commandArgs,
    options: Object.fromEntries(spec.options.map((name) => [name, { type: 'string' }])),
    strict: true,
  });

  const store = new Store(dataDir);
  const result = spec.run(store, parsed.values);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

try {
  main(process.argv.slice(2));
} catch (err) {
  process.stderr.write(`${err.name}: ${err.message}\n`);
  process.exitCode = 1;
}
