// CLI logic, importable for in-process testing.
//   auditdb load <file.jsonl> [--db path]
//   auditdb query <account> --valid <ISO-time> --tx <seq> [--db path]
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { AuditStore, AuditError } from './auditdb.js';

const DEFAULT_DB = 'auditdb.json';

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith('--')) {
      flags[argv[i].slice(2)] = argv[i + 1];
      i += 1;
    } else {
      positional.push(argv[i]);
    }
  }
  return { positional, flags };
}

function loadStore(dbPath) {
  if (!existsSync(dbPath)) return new AuditStore();
  return AuditStore.fromJSON(JSON.parse(readFileSync(dbPath, 'utf8')));
}

function saveStore(dbPath, store) {
  writeFileSync(dbPath, JSON.stringify(store.toJSON(), null, 2) + '\n');
}

// Returns process exit code; writes to the given sinks.
export function run(argv, io = { stdout: (s) => process.stdout.write(s), stderr: (s) => process.stderr.write(s) }) {
  try {
    const { positional, flags } = parseArgs(argv);
    const [command, ...rest] = positional;
    const dbPath = flags.db ?? DEFAULT_DB;

    if (command === 'load') {
      const file = rest[0];
      if (!file) throw new AuditError('E_USAGE', 'usage: auditdb load <file.jsonl> [--db path]');
      const store = loadStore(dbPath);
      const lines = readFileSync(file, 'utf8').split('\n').filter((l) => l.trim() !== '');
      let loaded = 0;
      for (const line of lines) {
        store.append(JSON.parse(line));
        loaded += 1;
      }
      saveStore(dbPath, store);
      io.stdout(JSON.stringify({ loaded, total: store.events.length, db: dbPath }) + '\n');
      return 0;
    }

    if (command === 'query') {
      const account = rest[0];
      if (!account || flags.valid === undefined || flags.tx === undefined) {
        throw new AuditError('E_USAGE', 'usage: auditdb query <account> --valid <ISO-time> --tx <seq> [--db path]');
      }
      const txSeq = Number(flags.tx);
      if (!Number.isInteger(txSeq)) throw new AuditError('E_USAGE', `--tx must be an integer, got ${flags.tx}`);
      const store = loadStore(dbPath);
      const result = store.asOf(account, flags.valid, txSeq);
      io.stdout(JSON.stringify({ account, validTime: flags.valid, txSeq, ...result }) + '\n');
      return 0;
    }

    throw new AuditError('E_USAGE', 'usage: auditdb <load|query> ...');
  } catch (err) {
    const code = err instanceof AuditError ? err.code : 'E_INTERNAL';
    io.stderr(`error: ${code}: ${err.message}\n`);
    return 1;
  }
}
