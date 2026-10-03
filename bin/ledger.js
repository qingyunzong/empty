#!/usr/bin/env node
import { Ledger, LedgerError } from '../src/ledger.js';

function parseArgs(argv) {
  const args = { positional: [], flags: {} };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('--')) {
        args.flags[key] = true;
      } else {
        args.flags[key] = next;
        index += 1;
      }
    } else {
      args.positional.push(token);
    }
  }
  return args;
}

function printJson(value) {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n');
}

function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const [command, ...rest] = positional;
  const file = flags.file;
  if (!command || !file) {
    process.stderr.write(
      'usage: ledger <reserve|commit|release|freeze|status> --file <path> ' +
        '[account] [amount] [--event-id <id>] [--crash beforeAppend|afterAppend] [--limit <n>]\n',
    );
    process.exit(2);
  }

  const crash = flags.crash ? { phase: flags.crash, at: 0 } : null;
  const ledger = Ledger.open(file, {
    crash,
    exitOnCrash: true,
    defaultLimit: flags.limit ? Number(flags.limit) : 1000,
  });

  if (ledger.recovery.truncated) {
    process.stderr.write(`recovery: truncated corrupt log at ${JSON.stringify(ledger.recovery)}\n`);
  }

  try {
    if (command === 'status') {
      printJson({
        recovery: ledger.recovery,
        eventCount: ledger.events.length,
        lastHash: ledger.lastHash,
        accounts: ledger.state(),
      });
      return;
    }

    const [account, amountArg] = rest;
    const eventId = flags['event-id'];
    let result;
    if (command === 'reserve' || command === 'commit' || command === 'release') {
      const amount = Number(amountArg);
      result = ledger[command](account, amount, eventId);
    } else if (command === 'freeze') {
      result = ledger.freeze(account, eventId);
    } else {
      process.stderr.write(`unknown command: ${command}\n`);
      process.exit(2);
    }
    printJson({
      ...result,
      eventCount: ledger.events.length,
      lastHash: ledger.lastHash,
      accounts: ledger.state(),
    });
  } catch (error) {
    if (error instanceof LedgerError) {
      printJson({ error: error.code, message: error.message });
      process.exit(1);
    }
    throw error;
  } finally {
    ledger.close();
  }
}

main();
