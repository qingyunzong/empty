#!/usr/bin/env node
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { planCommand, ticketView, BusinessError } from './state.js';
import {
  DEFAULT_QUOTA,
  CorruptionError,
  appendEvents,
  decodeTicket,
  ensureMeta,
  loadState,
  recover,
} from './ledger.js';

const MUTATIONS = new Set(['freeze', 'capture', 'release', 'expire', 'cancel']);

function parseOpts(args) {
  const opts = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = args[i + 1];
      if (next === undefined || next.startsWith('--')) {
        opts[key] = true;
      } else {
        opts[key] = next;
        i += 1;
      }
    }
  }
  return opts;
}

function parseAmount(raw, flag) {
  if (raw === undefined || raw === true || !/^\d+$/.test(String(raw))) {
    throw new BusinessError('INVALID_AMOUNT', `invalid amount for ${flag}: ${raw}`);
  }
  const amount = Number(raw);
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new BusinessError('INVALID_AMOUNT', `invalid amount for ${flag}: ${raw}`);
  }
  return amount;
}

function usage() {
  return [
    'usage: cli.js <command> [options]',
    '  freeze  --amount N --key K [--quota N]',
    '  capture --ticket T --amount N --key K',
    '  release --ticket T --amount N --key K',
    '  expire  --ticket T --key K',
    '  cancel  --ticket T --key K',
    '  ticket  --ticket T',
    '  recover',
    'options: --dir PATH (or LEDGER_DIR), --quota N (or LEDGER_QUOTA, first use only)',
    '',
  ].join('\n');
}

function runUnsafe(argv, env) {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === 'help' || cmd === '--help') {
    return { code: cmd ? 0 : 1, stdout: '', stderr: usage() };
  }
  const opts = parseOpts(rest);
  const dir = typeof opts.dir === 'string' ? opts.dir : env.LEDGER_DIR ?? './ledger';

  if (cmd === 'recover') {
    return { code: 0, stdout: `${JSON.stringify({ ok: true, result: recover(dir) })}\n`, stderr: '' };
  }

  if (cmd === 'ticket') {
    if (typeof opts.ticket !== 'string') {
      throw new BusinessError('MISSING_TICKET', 'missing --ticket');
    }
    const ticket = decodeTicket(dir, opts.ticket);
    if (!ticket) {
      throw new BusinessError('TICKET_NOT_FOUND', `ticket not found: ${opts.ticket}`);
    }
    return { code: 0, stdout: `${JSON.stringify({ ok: true, result: ticketView(ticket) })}\n`, stderr: '' };
  }

  if (MUTATIONS.has(cmd)) {
    if (typeof opts.key !== 'string' || opts.key.length === 0) {
      throw new BusinessError('MISSING_IDEMPOTENCY_KEY', 'missing --key');
    }
    const quota =
      opts.quota !== undefined
        ? parseAmount(opts.quota, '--quota')
        : env.LEDGER_QUOTA !== undefined
          ? parseAmount(env.LEDGER_QUOTA, 'LEDGER_QUOTA')
          : DEFAULT_QUOTA;
    ensureMeta(dir, quota);
    const loaded = loadState(dir);
    const replayed = loaded.state.idempotency[opts.key];
    if (replayed) {
      return { code: 0, stdout: `${JSON.stringify({ ok: true, replayed: true, result: replayed })}\n`, stderr: '' };
    }
    const command = { type: cmd };
    if (cmd === 'freeze') {
      command.amount = parseAmount(opts.amount, '--amount');
    } else {
      if (typeof opts.ticket !== 'string') {
        throw new BusinessError('MISSING_TICKET', 'missing --ticket');
      }
      command.ticketId = opts.ticket;
      if (cmd === 'capture' || cmd === 'release') {
        command.amount = parseAmount(opts.amount, '--amount');
      }
    }
    const plan = planCommand(loaded.state, command);
    const events = plan.events.map((ev) => ({ ...ev, key: opts.key, result: plan.result }));
    appendEvents(dir, events);
    return { code: 0, stdout: `${JSON.stringify({ ok: true, replayed: false, result: plan.result })}\n`, stderr: '' };
  }

  throw new BusinessError('UNKNOWN_COMMAND', `unknown command: ${cmd}`);
}

export function run(argv, env = {}) {
  try {
    return runUnsafe(argv, env);
  } catch (err) {
    if (err instanceof BusinessError) {
      return { code: 1, stdout: '', stderr: `${JSON.stringify({ ok: false, error: { code: err.code, message: err.message } })}\n` };
    }
    if (err instanceof CorruptionError) {
      return { code: 2, stdout: '', stderr: `${JSON.stringify({ ok: false, error: { code: 'LEDGER_CORRUPTED', message: err.message } })}\n` };
    }
    return { code: 1, stdout: '', stderr: `${JSON.stringify({ ok: false, error: { code: 'INTERNAL', message: String(err && err.message ? err.message : err) } })}\n` };
  }
}

const invokedAs = process.argv[1] ? fs.realpathSync(process.argv[1]) : '';
if (invokedAs === fileURLToPath(import.meta.url)) {
  const result = run(process.argv.slice(2), process.env);
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exit(result.code);
}
