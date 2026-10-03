#!/usr/bin/env node
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { Database } from './db.js';
import { BusinessError, CorruptionError } from './errors.js';

const USAGE = `Usage: batch-lineage <dbdir> <command> [json-args | -]

Commands (JSON in, JSON out):
  exec '<json-array>'      run a transaction script: [{"cmd":"begin"},{"cmd":"create","args":{...}},...,{"cmd":"commit"}]
  create|split|status      single mutation, auto-committed
  get|children|parents|ancestors|descendants|certificate|state   queries
  recover                  open the database, run WAL recovery, report

Exit codes: 0 ok, 1 business error, 2 corruption/internal error.`;

function runCommand(db, cmd, args = {}) {
  switch (cmd) {
    case 'begin': db.begin(); return { begun: true };
    case 'create': db.create(args); return { created: args.id };
    case 'split': db.split(args); return { split: (args.children ?? []).map((c) => c.id) };
    case 'status': db.setStatus(args); return { updated: args.id, status: args.status };
    case 'savepoint': db.savepoint(args.name); return { savepoint: args.name };
    case 'release': db.release(args.name); return { released: args.name };
    case 'rollback': db.rollbackTo(args.name); return { rolledBack: args.name };
    case 'commit': {
      const r = db.commit();
      return { committed: r.txid, certificates: r.certificates };
    }
    case 'abort': db.abort(); return { aborted: true };
    case 'get': return db.get(args.id);
    case 'children': return { id: args.id, children: db.children(args.id) };
    case 'parents': return { id: args.id, parents: db.parents(args.id) };
    case 'ancestors': return { id: args.id, ancestors: db.ancestors(args.id) };
    case 'descendants': return { id: args.id, descendants: db.descendants(args.id) };
    case 'certificate': return { id: args.id, certificate: db.certificate(args.id) };
    case 'state': return { batches: db.snapshot() };
    case 'recover': return { recovered: true, batches: db.snapshot().length };
    default: throw new BusinessError(`unknown command: ${cmd}`);
  }
}

const AUTO_COMMIT = new Set(['create', 'split', 'status']);

// Returns the process exit code: 0 ok, 1 business error, 2 corruption/internal.
export function runCli(argv, io = {}) {
  const out = io.stdout ?? ((s) => process.stdout.write(s));
  const err = io.stderr ?? ((s) => process.stderr.write(s));
  const readStdin = io.readStdin ?? (() => fs.readFileSync(0, 'utf8'));
  try {
    const [dir, cmd, ...rest] = argv;
    if (!dir || !cmd) {
      err(USAGE + '\n');
      return 2;
    }
    let argText = rest.join(' ');
    if (rest[0] === '-') argText = readStdin();
    const args = argText && argText.trim() ? JSON.parse(argText) : {};

    const db = Database.open(dir);
    try {
      if (cmd === 'exec') {
        if (!Array.isArray(args)) throw new BusinessError('exec: argument must be a JSON array of steps');
        const results = args.map((step) => runCommand(db, step.cmd, step.args ?? {}));
        out(JSON.stringify({ ok: true, results }) + '\n');
      } else if (AUTO_COMMIT.has(cmd)) {
        db.begin();
        const result = runCommand(db, cmd, args);
        const commit = db.commit();
        out(JSON.stringify({ ok: true, result, commit }) + '\n');
      } else {
        const result = runCommand(db, cmd, args);
        out(JSON.stringify({ ok: true, result }) + '\n');
      }
    } finally {
      db.close();
    }
    return 0;
  } catch (error) {
    if (error instanceof BusinessError) {
      out(JSON.stringify({ ok: false, error: { type: 'business', message: error.message } }) + '\n');
      return 1;
    }
    if (error instanceof CorruptionError) {
      out(JSON.stringify({ ok: false, error: { type: 'corruption', message: error.message } }) + '\n');
      return 2;
    }
    out(JSON.stringify({ ok: false, error: { type: 'internal', message: String(error?.message ?? error) } }) + '\n');
    return 2;
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href;
if (isMain) {
  process.exit(runCli(process.argv.slice(2)));
}
