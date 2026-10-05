import fs from 'node:fs';
import { VoucherStore, StoreError } from './index.js';

function parseFlags(args) {
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('--')) throw new StoreError('USAGE', `unexpected argument: ${arg}`);
    const key = arg.slice(2);
    const next = args[i + 1];
    if (next === undefined || next.startsWith('--')) {
      flags[key] = true;
    } else {
      flags[key] = next;
      i++;
    }
  }
  return flags;
}

function required(flags, name) {
  if (flags[name] === undefined || flags[name] === true) {
    throw new StoreError('USAGE', `missing required --${name}`);
  }
  return flags[name];
}

function readJsonl(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    throw new StoreError('IO_ERROR', `cannot read file: ${file}`);
  }
  return raw.split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .map((line, i) => {
      try {
        return JSON.parse(line);
      } catch {
        throw new StoreError('CORRUPT_JSON', `invalid JSON on line ${i + 1} of ${file}`);
      }
    });
}

function parseSlop(flags) {
  if (flags.slop === undefined) return 0;
  const raw = String(flags.slop);
  if (!/^-?\d+$/.test(raw)) throw new StoreError('INVALID_SLOP', `invalid slop: ${flags.slop}`);
  return Number(raw); // range check happens in the library
}

// Returns the process exit code; all output goes through io.stdout / io.stderr.
export function runCli(argv, io) {
  try {
    const [command, ...rest] = argv;
    const flags = parseFlags(rest);
    let result;
    switch (command) {
      case 'build': {
        const records = readJsonl(required(flags, 'file'));
        const store = VoucherStore.build(required(flags, 'dir'), records);
        result = { ok: true, version: store.version, documents: store.docs.size };
        break;
      }
      case 'add': {
        const records = readJsonl(required(flags, 'file'));
        const store = VoucherStore.open(required(flags, 'dir'));
        const version = store.addRecords(records);
        result = { ok: true, version, documents: store.docs.size };
        break;
      }
      case 'query': {
        const store = VoucherStore.open(required(flags, 'dir'));
        result = store.phraseQuery(required(flags, 'phrase'), { slop: parseSlop(flags) });
        break;
      }
      case 'revoke': {
        const store = VoucherStore.open(required(flags, 'dir'));
        store.revoke(required(flags, 'id'));
        result = { ok: true, revoked: String(flags.id) };
        break;
      }
      case 'restore': {
        const store = VoucherStore.open(required(flags, 'dir'));
        store.restore(required(flags, 'id'));
        result = { ok: true, restored: String(flags.id) };
        break;
      }
      default:
        throw new StoreError('USAGE', 'commands: build|add|query|revoke|restore (--dir required)');
    }
    io.stdout(JSON.stringify(result) + '\n');
    return 0;
  } catch (err) {
    const code = err instanceof StoreError ? err.code : 'INTERNAL';
    const message = err instanceof Error ? err.message : String(err);
    io.stderr(JSON.stringify({ error: message, code }) + '\n');
    return 1;
  }
}
