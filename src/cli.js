#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { Ledger, LedgerError } from './ledger.js';

const DEFAULT_STATE_FILE = 'ledger.state.json';

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq !== -1) {
        pushFlag(flags, arg.slice(2, eq), arg.slice(eq + 1));
      } else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        pushFlag(flags, arg.slice(2), argv[i + 1]);
        i += 1;
      } else {
        pushFlag(flags, arg.slice(2), 'true');
      }
    } else {
      positional.push(arg);
    }
  }
  return { flags, positional };
}

function pushFlag(flags, key, value) {
  if (key in flags) {
    flags[key] = Array.isArray(flags[key]) ? [...flags[key], value] : [flags[key], value];
  } else {
    flags[key] = value;
  }
}

function parseJsonArg(raw, code = 'invalid-json') {
  try {
    return JSON.parse(raw);
  } catch {
    throw new LedgerError(code, 'failed to parse JSON input');
  }
}

function readStdin() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function dataArg(positional, flags) {
  const raw = positional[0];
  if (raw === '-') return parseJsonArg(readStdin());
  if (raw !== undefined) return parseJsonArg(raw);
  const data = {};
  for (const key of ['id', 'payer', 'payee', 'hash', 'party']) {
    if (flags[key] !== undefined) data[key] = flags[key];
  }
  for (const key of ['amount', 'budget']) {
    if (flags[key] !== undefined) data[key] = Number(flags[key]);
  }
  if (Object.keys(data).length === 0 && !process.stdin.isTTY) {
    const stdin = readStdin().trim();
    if (stdin) return parseJsonArg(stdin);
  }
  return data;
}

function parseBudgetFlags(flags) {
  const budgets = {};
  const entries = flags.budget === undefined
    ? []
    : Array.isArray(flags.budget)
      ? flags.budget
      : [flags.budget];
  for (const entry of entries) {
    const eq = String(entry).indexOf('=');
    if (eq === -1) throw new LedgerError('invalid-event', 'budget flag must be Party=amount');
    budgets[String(entry).slice(0, eq)] = Number(String(entry).slice(eq + 1));
  }
  return budgets;
}

function loadEventsFile(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    throw new LedgerError('file-not-found', `cannot read merge file: ${path}`);
  }
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : parsed.events ?? [parsed];
  } catch {
    const events = [];
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (trimmed) events.push(parseJsonArg(trimmed));
    }
    return events;
  }
}

function loadLedger(statePath) {
  if (!existsSync(statePath)) return new Ledger();
  return Ledger.fromJSON(parseJsonArg(readFileSync(statePath, 'utf8'), 'invalid-state'));
}

function saveLedger(statePath, ledger) {
  writeFileSync(statePath, `${JSON.stringify(ledger.toJSON(), null, 2)}\n`);
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function fail(code) {
  print({ error: code });
  process.exitCode = 1;
}

export function run(argv) {
  const { flags, positional } = parseArgs(argv);
  const command = positional[0];
  const statePath = flags.state ?? process.env.LEDGER_STATE ?? DEFAULT_STATE_FILE;
  const rest = positional.slice(1);

  const ledger = loadLedger(statePath);

  switch (command) {
    case 'instruct': {
      const record = ledger.instruct(dataArg(rest, flags));
      saveLedger(statePath, ledger);
      print({ ok: true, id: record.id, hash: record.hash });
      return;
    }
    case 'cancel': {
      const tombstone = ledger.cancel(dataArg(rest, flags));
      saveLedger(statePath, ledger);
      print({ ok: true, id: tombstone.id, tombstone: true });
      return;
    }
    case 'budget': {
      const event = ledger.setBudget(dataArg(rest, flags));
      saveLedger(statePath, ledger);
      print({ ok: true, party: event.party, budget: event.budget });
      return;
    }
    case 'merge': {
      const file = rest[0];
      if (!file) throw new LedgerError('invalid-event', 'merge requires a file argument');
      const applied = ledger.merge(loadEventsFile(file));
      saveLedger(statePath, ledger);
      print({ ok: true, applied: applied.length });
      return;
    }
    case 'net': {
      print({ net: ledger.net() });
      return;
    }
    case 'settle': {
      const overrides = parseBudgetFlags(flags);
      const json = rest[0] !== undefined ? parseJsonArg(rest[0]) : {};
      const budgets = { ...overrides, ...(json.budgets ?? {}) };
      for (const [party, budget] of Object.entries(budgets)) {
        ledger.setBudget({ party, budget });
      }
      const certificate = ledger.settle();
      print(certificate);
      return;
    }
    default:
      throw new LedgerError('unknown-command', `unknown command: ${command ?? '(none)'}`);
  }
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  try {
    run(process.argv.slice(2));
  } catch (error) {
    if (error instanceof LedgerError) {
      fail(error.code);
    } else {
      fail('internal-error');
      process.stderr.write(`${error.stack ?? error}\n`);
    }
  }
}
