import { AuditDB } from './db.js';
import { AuditError } from './errors.js';
import { readJsonl, appendJsonl } from './store.js';

const USAGE = `usage:
  auditdb load <file.jsonl> [--db path]
  auditdb query <account> --valid <ISO-time> [--tx N] [--db path]

event fields: id, account, validFrom, validTo(nullable), txSeq,
              payload{amount,limit}, supersedes, tombstone
errors: E_TIME_ORDER (bad valid interval / non-increasing txSeq),
        E_TOMBSTONE (supersede a tombstone / tombstone without supersedes)`;

function parseFlags(args) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (next === undefined || next.startsWith('--')) flags[key] = true;
      else { flags[key] = next; i++; }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

class UsageError extends Error {}

// Runs one CLI invocation. Returns the process exit code (0 = ok, 1 = error).
// io: { stdout(line), stderr(line), env } — injectable for tests.
export function runCli(argv, io = {}) {
  const stdout = io.stdout ?? ((s) => process.stdout.write(s + '\n'));
  const stderr = io.stderr ?? ((s) => process.stderr.write(s + '\n'));
  const env = io.env ?? process.env;
  try {
    return main(argv, { stdout, stderr, env });
  } catch (err) {
    if (err instanceof AuditError) {
      stderr(JSON.stringify({ error: err.code, message: err.message }));
    } else if (err instanceof UsageError) {
      stderr(JSON.stringify({ error: 'E_USAGE', message: err.message }));
    } else {
      stderr(JSON.stringify({ error: 'E_INTERNAL', message: String(err?.message ?? err) }));
    }
    return 1;
  }
}

function main(argv, { stdout, stderr, env }) {
  const [cmd, ...rest] = argv;
  const { positional, flags } = parseFlags(rest);
  const dbPath = typeof flags.db === 'string' ? flags.db
    : env.AUDITDB_PATH || 'auditdb.jsonl';

  if (cmd === 'load') {
    const file = positional[0];
    if (!file) throw new UsageError('load requires a jsonl file');
    const incoming = readJsonl(file);
    const db = new AuditDB();
    db.load(readJsonl(dbPath));   // replay existing store
    db.load(incoming);            // validate everything before persisting
    appendJsonl(dbPath, incoming);
    stdout(JSON.stringify({ loaded: incoming.length, total: db.events.length, db: dbPath }));
    return 0;
  }

  if (cmd === 'query') {
    const account = positional[0];
    if (!account) throw new UsageError('query requires an account');
    if (typeof flags.valid !== 'string') throw new UsageError('query requires --valid <ISO-time>');
    let tx = Number.MAX_SAFE_INTEGER;
    if (flags.tx !== undefined) {
      tx = Number(flags.tx);
      if (!Number.isInteger(tx) || tx < 1) throw new UsageError('--tx must be a positive integer');
    }
    const db = new AuditDB();
    db.load(readJsonl(dbPath));
    const result = db.asOf(account, flags.valid, tx);
    if (flags.tx === undefined) result.tx = db.lastTxSeq;
    stdout(JSON.stringify(result));
    return 0;
  }

  stderr(USAGE);
  return (cmd === undefined || cmd === 'help' || cmd === '--help') ? 0 : 1;
}
