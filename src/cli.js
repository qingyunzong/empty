#!/usr/bin/env node
import { LedgerStore, LedgerError, CRASH_POINTS } from './ledger.js';

const USAGE = `usage:
  ledger run <ledger.json> [--crash EVENT:POINT]   recover, then net-settle all pending entries
  ledger recover <ledger.json>                     replay snapshot+changelog, print state
  ledger submit <ledger.json> <entryId> <payer> <payee> <amount>
  ledger cancel <ledger.json> <entryId>
crash points: ${CRASH_POINTS.map((p) => `settle:${p}`).join(', ')}`;

function parseCrash(argv) {
  const idx = argv.indexOf('--crash');
  if (idx === -1) return null;
  const spec = argv[idx + 1];
  const [event, point] = String(spec ?? '').split(':');
  if (event !== 'settle' || !CRASH_POINTS.includes(point)) {
    throw new LedgerError('BAD_CRASH_SPEC', `unknown --crash ${spec}`);
  }
  return point;
}

function printState(store) {
  const snap = store.snapshot();
  for (const e of snap.entries) {
    console.log(`entry ${e.entryId} ${e.payer}->${e.payee} ${e.amount} ${e.status}`);
  }
  console.log(`recoveryHash=${snap.recoveryHash}`);
}

function main() {
  const [cmd, file, ...rest] = process.argv.slice(2);
  if (!cmd || !file) {
    console.error(USAGE);
    process.exit(64);
  }
  const store = new LedgerStore(file);
  store.recover();

  if (cmd === 'recover') {
    printState(store);
  } else if (cmd === 'submit') {
    const [entryId, payer, payee, amount] = rest;
    store.submit({ entryId, payer, payee, amount: Number(amount) });
    printState(store);
  } else if (cmd === 'cancel') {
    store.cancel(rest[0]);
    printState(store);
  } else if (cmd === 'run') {
    const crashPoint = parseCrash(rest);
    if (crashPoint) {
      store.crashPoint = crashPoint;
      store.crashMode = 'exit'; // real process crash, no cleanup
    }
    const result = store.settle();
    console.log(`settled=${result.settledIds.join(',')}`);
    for (const [participant, net] of Object.entries(result.nets)) {
      console.log(`net ${participant}=${net}`);
    }
    console.log(`recoveryHash=${result.recoveryHash}`);
  } else {
    console.error(USAGE);
    process.exit(64);
  }
}

try {
  main();
} catch (err) {
  if (err instanceof LedgerError) {
    console.error(`error ${err.code} ${err.message}`);
    process.exit(2);
  }
  throw err;
}
