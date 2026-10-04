#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { runEngine } from './engine.js';

const USAGE = [
  'Usage: node src/cli.js <ticks.json> <accounts.json> [--slots N] [--slot-capacity C]',
  '',
  'accounts.json: array of accounts, or { "accounts": [...], "config": { "slots": N, "slotCapacity": C } }',
  '  account: { "id", "priority", "liquidationLine", "deadlineSlot", "cash", "position" }',
  'ticks.json: array of events',
  '  tick:  { "accountId", "price", "version" }',
  '  undo:  { "op": "undo", "accountId", "version" }',
  '',
].join('\n');

function parseArgs(argv) {
  const positional = [];
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--slots') opts.slots = Number(argv[++i]);
    else if (a === '--slot-capacity') opts.slotCapacity = Number(argv[++i]);
    else if (a === '--help' || a === '-h') return { help: true };
    else if (a.startsWith('--')) return { error: `unknown option: ${a}` };
    else positional.push(a);
  }
  return { positional, opts };
}

// Returns process exit code; writes through io.out / io.err.
export function runCli(argv, io = { out: (s) => process.stdout.write(s), err: (s) => process.stderr.write(s) }) {
  const parsed = parseArgs(argv);
  if (parsed.help) {
    io.out(USAGE);
    return 0;
  }
  if (parsed.error) {
    io.err(parsed.error + '\n' + USAGE);
    return 2;
  }
  const { positional, opts } = parsed;
  if (positional.length !== 2) {
    io.err(USAGE);
    return 2;
  }
  const [ticksPath, accountsPath] = positional;

  let ticks;
  let accountsRaw;
  try {
    ticks = JSON.parse(readFileSync(ticksPath, 'utf8'));
    accountsRaw = JSON.parse(readFileSync(accountsPath, 'utf8'));
  } catch (err) {
    io.err(`failed to read input: ${err.message}\n`);
    return 2;
  }
  if (!Array.isArray(ticks)) {
    io.err('ticks.json must be a JSON array of events\n');
    return 2;
  }
  const accounts = Array.isArray(accountsRaw) ? accountsRaw : accountsRaw.accounts;
  const fileConfig = Array.isArray(accountsRaw) ? {} : accountsRaw.config ?? {};
  if (!Array.isArray(accounts)) {
    io.err('accounts.json must be an array or { accounts, config }\n');
    return 2;
  }

  const config = { ...fileConfig };
  if (opts.slots !== undefined) config.slots = opts.slots;
  if (opts.slotCapacity !== undefined) config.slotCapacity = opts.slotCapacity;

  const result = runEngine(accounts, ticks, config);
  io.out(JSON.stringify(result, null, 2) + '\n');
  return 0;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  process.exit(runCli(process.argv.slice(2)));
}
