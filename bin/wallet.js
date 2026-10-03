#!/usr/bin/env node
import { WalletStore } from '../src/store.js';

const USAGE = `wallet — hold reservation CLI (Node 22, offline)

usage: node bin/wallet.js [--data DIR] [--compact-threshold N] <command> [opts]

commands:
  deposit  --wallet W --amount N --rev R
  freeze   --wallet W --amount N --memo TEXT --rev R
  release  --id HOLD_ID --rev R
  cancel   --id HOLD_ID --rev R
  balance  --wallet W
  search   --query TEXT [--near K] [--include-history]
  records  [--include-history]
  compact

All mutating commands require --rev equal to the current store rev;
a mismatch is a concurrency conflict and the whole command is rejected
(exit code 2) with the current rev and a hash-chain certificate.
Output is JSON on stdout. Exit codes: 0 ok, 2 conflict, 1 other error.`;

function parseArgs(argv) {
  const flags = new Map();
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        flags.set(key, true);
      } else {
        flags.set(key, next);
        i += 1;
      }
    } else {
      positional.push(arg);
    }
  }
  return { flags, positional };
}

function num(flags, key, { required = false } = {}) {
  const raw = flags.get(key);
  if (raw === undefined) {
    if (required) throw new Error(`missing --${key}`);
    return undefined;
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new Error(`--${key} must be an integer, got: ${raw}`);
  }
  return value;
}

function str(flags, key, { required = false } = {}) {
  const raw = flags.get(key);
  if (raw === undefined || raw === true) {
    if (required) throw new Error(`missing --${key}`);
    return undefined;
  }
  return raw;
}

function main() {
  const { flags, positional } = parseArgs(process.argv.slice(2));
  const [command] = positional;
  if (!command || flags.has('help')) {
    console.log(USAGE);
    process.exitCode = command ? 0 : 1;
    return;
  }

  const dir = str(flags, 'data') ?? './wallet-data';
  const store = new WalletStore(dir, {
    compactThreshold: num(flags, 'compact-threshold') ?? undefined,
  });

  let result;
  switch (command) {
    case 'deposit':
      result = store.deposit({
        wallet: str(flags, 'wallet', { required: true }),
        amount: num(flags, 'amount', { required: true }),
        expectedRev: num(flags, 'rev', { required: true }),
      });
      break;
    case 'freeze':
      result = store.freeze({
        wallet: str(flags, 'wallet', { required: true }),
        amount: num(flags, 'amount', { required: true }),
        memo: str(flags, 'memo') ?? '',
        expectedRev: num(flags, 'rev', { required: true }),
      });
      break;
    case 'release':
      result = store.release({
        id: str(flags, 'id', { required: true }),
        expectedRev: num(flags, 'rev', { required: true }),
      });
      break;
    case 'cancel':
      result = store.cancel({
        id: str(flags, 'id', { required: true }),
        expectedRev: num(flags, 'rev', { required: true }),
      });
      break;
    case 'balance':
      result = store.balance(str(flags, 'wallet', { required: true }));
      break;
    case 'search':
      result = store.search(str(flags, 'query', { required: true }), {
        near: num(flags, 'near'),
        includeHistory: flags.has('include-history'),
      });
      break;
    case 'records':
      result = {
        ok: true,
        rev: store.rev,
        results: store
          .records()
          .filter((r) => flags.has('include-history') || r.state !== 'cancelled'),
      };
      break;
    case 'compact':
      result = store.compact();
      break;
    default:
      console.error(`unknown command: ${command}\n\n${USAGE}`);
      process.exitCode = 1;
      return;
  }

  console.log(JSON.stringify(result, null, 2));
  if (result.ok) return;
  process.exitCode = result.code === 'CONFLICT' ? 2 : 1;
}

try {
  main();
} catch (err) {
  console.error(JSON.stringify({ ok: false, error: err.message }));
  process.exitCode = 1;
}
