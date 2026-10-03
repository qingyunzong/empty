#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const {
  ReplicaError,
  createState,
  balance,
  applyReserve,
  applyRelease,
  diff,
  merge,
} = require('./src/replica');

const DEFAULT_LIMIT = 1000;

function loadState(file) {
  if (!fs.existsSync(file)) {
    throw new ReplicaError('not-found');
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function loadOrInit(file, limit) {
  if (fs.existsSync(file)) {
    return loadState(file);
  }
  return createState(limit);
}

function saveState(file, state) {
  fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`);
}

function parseAmount(raw) {
  const amount = Number(raw);
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new ReplicaError('invalid-amount');
  }
  return amount;
}

function parseLimitFlag(args) {
  const index = args.indexOf('--limit');
  if (index === -1) return DEFAULT_LIMIT;
  const limit = Number(args[index + 1]);
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new ReplicaError('invalid-limit');
  }
  return limit;
}

function execute(argv) {
  const [command, ...args] = argv;

  switch (command) {
    case 'reserve': {
      const [file, requestId, account, rawAmount, ...rest] = args;
      if (!file || !requestId || !account || rawAmount === undefined) {
        throw new ReplicaError('usage');
      }
      const state = loadOrInit(file, parseLimitFlag(rest));
      const result = applyReserve(state, {
        requestId,
        account,
        amount: parseAmount(rawAmount),
      });
      saveState(file, state);
      return { ok: true, applied: result.applied, balance: balance(state) };
    }
    case 'release': {
      const [file, requestId, target, rawAmount] = args;
      if (!file || !requestId || !target || rawAmount === undefined) {
        throw new ReplicaError('usage');
      }
      const state = loadState(file);
      const result = applyRelease(state, {
        requestId,
        target,
        amount: parseAmount(rawAmount),
      });
      saveState(file, state);
      return { ok: true, applied: result.applied, balance: balance(state) };
    }
    case 'diff': {
      const [file, otherFile] = args;
      if (!file || !otherFile) throw new ReplicaError('usage');
      return diff(loadState(file), loadState(otherFile));
    }
    case 'repair': {
      const [file, otherFile] = args;
      if (!file || !otherFile) throw new ReplicaError('usage');
      const mine = loadState(file);
      const applied = merge(mine, loadState(otherFile));
      saveState(file, mine);
      return { ok: true, merged: applied, balance: balance(mine) };
    }
    case 'balance': {
      const [file] = args;
      if (!file) throw new ReplicaError('usage');
      return balance(loadState(file));
    }
    default:
      throw new ReplicaError('unknown-command');
  }
}

function run(argv) {
  try {
    return { code: 0, json: execute(argv) };
  } catch (error) {
    const code = error instanceof ReplicaError ? error.code : 'internal';
    return { code: 1, json: { error: code } };
  }
}

module.exports = { run };

if (require.main === module) {
  const { code, json } = run(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(json)}\n`);
  process.exitCode = code;
}
