#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore, StoreError } from './store.js';

function parseArgs(argv) {
  const args = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      args.push(a);
    }
  }
  return { args, flags };
}

function draftPath(dir) {
  return path.join(dir, 'draft.json');
}

function loadDraft(dir) {
  try {
    return JSON.parse(fs.readFileSync(draftPath(dir), 'utf8'));
  } catch {
    return { writes: {} };
  }
}

function saveDraft(dir, draft) {
  fs.mkdirSync(dir, { recursive: true });
  const tmp = draftPath(dir) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(draft, null, 2) + '\n');
  fs.renameSync(tmp, draftPath(dir));
}

function clearDraft(dir) {
  try {
    fs.unlinkSync(draftPath(dir));
  } catch {}
}

const EXIT_CODES = { FROZEN: 2, NO_VERSION: 3, NO_KEY: 4, TAMPER: 5 };

const USAGE = `snapstore - snapshot-isolated KV store with immutable published versions

usage: snapstore [--dir PATH] <command> ...

commands:
  put <key> <value>          stage a write in the draft transaction
  commit                     commit the draft transaction as a new version
  discard                    drop the staged draft transaction
  publish <version>          freeze a version and emit its content certificate
  get <key> [--version N | --cert HEX]   read a key (default: latest state)
  verify [--version N | --cert HEX]      verify a published version's certificate
  status                     show current version and published versions

error codes: FROZEN (write touches a published key), NO_VERSION (unknown version/cert), TAMPER (certificate mismatch)
`;

// Programmatic entry: returns an exit code, writes via io.{stdout,stderr}.
export function run(argv, io = {}) {
  const stdout = io.stdout || ((s) => process.stdout.write(s));
  const stderr = io.stderr || ((s) => process.stderr.write(s));
  const env = io.env || process.env;

  const { args, flags } = parseArgs(argv);
  const [cmd, ...rest] = args;
  const dir = flags.dir || env.SNAPSTORE_DIR || path.join(process.cwd(), '.snapstore');

  if (!cmd || cmd === 'help' || flags.help) {
    stdout(USAGE);
    return 0;
  }

  try {
    const store = openStore(dir);
    try {
      switch (cmd) {
        case 'put': {
          const [key, value] = rest;
          if (key === undefined || value === undefined) throw new StoreError('USAGE', 'put <key> <value>');
          const draft = loadDraft(dir);
          draft.writes[key] = value;
          saveDraft(dir, draft);
          stdout(`staged ${key}\n`);
          break;
        }
        case 'commit': {
          const draft = loadDraft(dir);
          const entries = Object.entries(draft.writes || {});
          if (entries.length === 0) throw new StoreError('USAGE', 'draft is empty; nothing to commit');
          const txn = store.begin();
          for (const [k, v] of entries) txn.put(k, v);
          const version = txn.commit();
          clearDraft(dir);
          stdout(`version ${version}\n`);
          break;
        }
        case 'discard': {
          clearDraft(dir);
          stdout('draft discarded\n');
          break;
        }
        case 'publish': {
          const version = Number(rest[0]);
          if (!Number.isInteger(version)) throw new StoreError('USAGE', 'publish <version>');
          const cert = store.publish(version, { crashAt: env.SNAPSTORE_CRASH_AT });
          stdout(`published version ${version}\ncert ${cert}\n`);
          break;
        }
        case 'get': {
          const key = rest[0];
          if (key === undefined) throw new StoreError('USAGE', 'get <key> [--version N | --cert HEX]');
          let value;
          if (flags.cert !== undefined) {
            value = store.getPublished(key, { cert: String(flags.cert) });
          } else if (flags.version !== undefined) {
            value = store.getAt(key, Number(flags.version));
          } else {
            value = store.get(key);
          }
          if (value === undefined) {
            stderr(`NO_KEY: key "${key}" not found\n`);
            return EXIT_CODES.NO_KEY;
          }
          stdout(value + '\n');
          break;
        }
        case 'verify': {
          let result;
          if (flags.cert !== undefined) {
            result = store.verify({ cert: String(flags.cert) });
          } else if (flags.version !== undefined) {
            result = store.verify({ version: Number(flags.version) });
          } else {
            throw new StoreError('USAGE', 'verify --version N | --cert HEX');
          }
          stdout(`OK version ${result.version} cert ${result.cert}\n`);
          break;
        }
        case 'status': {
          stdout(`current version ${store.currentVersion()}\n`);
          stdout(`published ${store.publishedVersions().join(' ') || '(none)'}\n`);
          break;
        }
        default:
          throw new StoreError('USAGE', `unknown command: ${cmd}`);
      }
    } finally {
      store.close();
    }
    return 0;
  } catch (err) {
    if (err instanceof StoreError) {
      stderr(`${err.code}: ${err.message}\n`);
      return EXIT_CODES[err.code] ?? 1;
    }
    stderr(`ERROR: ${err.message}\n`);
    return 1;
  }
}

const invokedAsScript = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (invokedAsScript) {
  process.exitCode = run(process.argv.slice(2));
}
