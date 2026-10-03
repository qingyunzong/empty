#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const { Ledger, CrashError } = require('./ledger');

const USAGE = `Usage:
  node cli.js state   <file> [--limit N]
  node cli.js reserve <file> <account> <amount> [--event-id ID] [--limit N] [--crash beforeAppend|afterAppend]
  node cli.js commit  <file> <account> <amount> [--event-id ID] [--limit N] [--crash beforeAppend|afterAppend]
  node cli.js release <file> <account> <amount> [--event-id ID] [--limit N] [--crash beforeAppend|afterAppend]
  node cli.js freeze  <file> <account>          [--event-id ID] [--limit N] [--crash beforeAppend|afterAppend]

Exit codes: 0 ok, 1 crash at beforeAppend (event not persisted), 42 crash at afterAppend (event persisted), 2 usage/ rejected.`;

function parseFlags(args) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < args.length; i += 1) {
    if (args[i].startsWith('--')) {
      flags[args[i].slice(2)] = args[i + 1];
      i += 1;
    } else {
      positional.push(args[i]);
    }
  }
  return { positional, flags };
}

function main(argv) {
  const [command, ...rest] = argv;
  const { positional, flags } = parseFlags(rest);
  const limit = flags.limit === undefined ? undefined : Number(flags.limit);
  const options = limit === undefined ? {} : { limit };

  if (command === 'state') {
    const [file] = positional;
    if (!file) return usage();
    const ledger = new Ledger(file, options);
    console.log(JSON.stringify({ recovery: ledger.recovery, state: ledger.snapshot() }, null, 2));
    return 0;
  }

  if (command === 'reserve' || command === 'commit' || command === 'release' || command === 'freeze') {
    const [file, account, amountArg] = positional;
    if (!file || !account) return usage();
    const amount = command === 'freeze' ? 0 : Number(amountArg);
    if (command !== 'freeze' && (!Number.isFinite(amount) || amount < 0)) return usage();
    const eventId = flags['event-id'] || crypto.randomUUID();
    const crash = flags.crash || null;
    const ledger = new Ledger(file, options);
    try {
      const result = ledger.append(
        { eventId, type: command, account, amount },
        { crash },
      );
      console.log(JSON.stringify({ ...result, recovery: ledger.recovery, state: ledger.snapshot() }, null, 2));
      return result.applied ? 0 : 2;
    } catch (err) {
      if (err instanceof CrashError) {
        console.log(JSON.stringify({ crashed: err.point, eventId, seq: ledger.seq + 1 }, null, 2));
        return err.point === 'afterAppend' ? 42 : 1;
      }
      throw err;
    }
  }

  return usage();
}

function usage() {
  console.error(USAGE);
  return 2;
}

process.exitCode = main(process.argv.slice(2));
