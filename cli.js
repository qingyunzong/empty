#!/usr/bin/env node
import fs from 'node:fs';
import { Store, recoverFromDisk, CRASH_POINTS } from './src/store.js';
import { stateHash, LedgerError } from './src/ledger.js';

const EXIT_CRASH = 75;
const EXIT_OP_ERROR = 2;
const EXIT_USAGE = 64;

function usage() {
  console.error(`usage:
  node cli.js run <ledger.json> [--crash EVENT:POINT]
  node cli.js recover <ledger.json>

events: settle   points: ${CRASH_POINTS.map((p) => p.split(':')[1]).join(', ')}`);
  process.exit(EXIT_USAGE);
}

function parseCrashPoint(args) {
  const idx = args.indexOf('--crash');
  if (idx === -1) return null;
  const value = args[idx + 1];
  if (!value || !CRASH_POINTS.includes(value)) {
    console.error(`invalid --crash point ${JSON.stringify(value)}; valid: ${CRASH_POINTS.join(', ')}`);
    process.exit(EXIT_USAGE);
  }
  return value;
}

function cmdRun(ledgerPath, args) {
  const crashAt = parseCrashPoint(args);
  const spec = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
  if (!Array.isArray(spec.ops)) {
    console.error('ledger file must contain {"ops": [...]}');
    process.exit(EXIT_USAGE);
  }
  const store = new Store(`${ledgerPath}.state`, {
    onCrashPoint(point) {
      if (point === crashAt) {
        console.error(`CRASH simulated at ${point}`);
        process.exit(EXIT_CRASH);
      }
    },
  });
  console.log(`recovered from ${store.recoverySource}; applying ${spec.ops.length} op(s)`);
  for (const op of spec.ops) {
    try {
      if (op.op === 'submit') {
        const r = store.submit(op);
        console.log(`submit ${op.entryId}: ${r.duplicate ? 'duplicate (idempotent no-op)' : 'ok'}`);
      } else if (op.op === 'cancel') {
        store.cancel(op.entryId);
        console.log(`cancel ${op.entryId}: ok`);
      } else if (op.op === 'settle') {
        const r = store.settle();
        console.log(
          r.changed
            ? `settle: ok settled=${r.settlement.entryIds.length} nets=${JSON.stringify(r.settlement.nets)}`
            : 'settle: no-op (no pending entries)',
        );
      } else {
        console.error(`ERROR UNKNOWN_OP: ${JSON.stringify(op.op)}`);
        process.exit(EXIT_OP_ERROR);
      }
    } catch (err) {
      if (err instanceof LedgerError) {
        console.error(`ERROR ${err.code}: ${err.message}`);
        process.exit(EXIT_OP_ERROR);
      }
      throw err;
    }
  }
  console.log(`final stateHash ${stateHash(store.state)}`);
}

function cmdRecover(ledgerPath) {
  const { state, source, tornTail, recoveryHash } = recoverFromDisk(`${ledgerPath}.state`);
  console.log(JSON.stringify({ source, tornTail, recoveryHash, state }, null, 2));
}

const [cmd, ledgerPath, ...rest] = process.argv.slice(2);
if (cmd === 'run' && ledgerPath) {
  cmdRun(ledgerPath, rest);
} else if (cmd === 'recover' && ledgerPath) {
  cmdRecover(ledgerPath);
} else {
  usage();
}
