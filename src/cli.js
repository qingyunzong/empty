#!/usr/bin/env node
import path from 'node:path';
import {
  BusinessError,
  CorruptionError,
  decodeTicket,
  execute,
  recover,
} from './store.js';

function parseFlags(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) flags[key] = true;
      else { flags[key] = next; i += 1; }
    }
  }
  return flags;
}

function usage() {
  return [
    'usage: cli.js <command> [flags]',
    'commands:',
    '  freeze   --amount N [--idempotency-key K]',
    '  capture  --ticket T --amount N [--idempotency-key K]',
    '  release  --ticket T --amount N [--idempotency-key K]',
    '  expire   --ticket T [--idempotency-key K]',
    '  cancel   --ticket T [--idempotency-key K]',
    '  ticket   --ticket T',
    '  recover',
    'flags: --data-dir D --limit N',
  ].join('\n');
}

function main() {
  const command = process.argv[2];
  const flags = parseFlags(process.argv.slice(3));
  const dir = flags['data-dir'] ?? process.env.FZ_DATA_DIR ?? path.resolve('fzdata');
  const limitFlag = flags.limit ?? process.env.FZ_CREDIT_LIMIT;
  const creditLimit = limitFlag !== undefined ? Number(limitFlag) : undefined;
  const key = flags['idempotency-key'] ?? flags.key;

  if (!command) throw new BusinessError(`missing command\n${usage()}`);

  if (command === 'recover') {
    const report = recover(dir);
    console.log(JSON.stringify({ ok: true, command, ...report }));
    return;
  }

  if (command === 'ticket') {
    if (!flags.ticket) throw new BusinessError('missing --ticket');
    const decoded = decodeTicket(dir, flags.ticket);
    console.log(JSON.stringify({ ok: true, command, ...decoded }));
    return;
  }

  if (!['freeze', 'capture', 'release', 'expire', 'cancel'].includes(command)) {
    throw new BusinessError(`unknown command ${command}\n${usage()}`);
  }

  const args = { key };
  if (command === 'freeze' || command === 'capture' || command === 'release') {
    if (flags.amount === undefined) throw new BusinessError('missing --amount');
    args.amount = Number(flags.amount);
  }
  if (command !== 'freeze') {
    if (!flags.ticket) throw new BusinessError('missing --ticket');
    args.ticket = flags.ticket;
  }

  const { result, replayed } = execute(dir, command, args, { creditLimit });
  console.log(JSON.stringify({ ok: true, command, replayed, ...result }));
}

try {
  main();
} catch (err) {
  if (err instanceof BusinessError) {
    console.error(`error: ${err.message}`);
    process.exit(1);
  }
  if (err instanceof CorruptionError) {
    console.error(`corruption: ${err.message}`);
    process.exit(2);
  }
  throw err;
}
