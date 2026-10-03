#!/usr/bin/env node
// maint: offline work-order history CLI.
// Commands: commit / branch / merge / undo / query / compact
// Error codes: E_CLOCK, E_CONFLICT, E_VERSION (exit 1).

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { Store, StoreError } from '../src/store.js';

const DEFAULT_STORE = 'maint-store.json';

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const body = a.slice(2);
      const eq = body.indexOf('=');
      if (eq !== -1) {
        push(args, body.slice(0, eq), body.slice(eq + 1));
      } else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        push(args, body, argv[++i]);
      } else {
        args[body] = true;
      }
    } else {
      args._.push(a);
    }
  }
  return args;
}

function push(args, key, value) {
  if (args[key] === undefined) args[key] = [value];
  else args[key].push(value);
}

function one(args, key) {
  const v = args[key];
  if (Array.isArray(v)) return v[v.length - 1];
  return v;
}

function parseSet(spec) {
  // doc.field=value  (doc/field split at the first '.', value may contain '=')
  const dot = spec.indexOf('.');
  const eq = spec.indexOf('=', dot);
  if (dot === -1 || eq === -1) throw new StoreError('E_VERSION', `bad --set spec: ${spec}`);
  return { doc: spec.slice(0, dot), field: spec.slice(dot + 1, eq), value: spec.slice(eq + 1) };
}

function parseLamport(args) {
  const raw = one(args, 'lamport');
  if (raw === undefined || raw === true) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n)) throw new StoreError('E_CLOCK', `invalid lamport: ${raw}`);
  return n;
}

const USAGE = `usage:
  maint commit  --branch B [--set doc.field=value]... [--delete doc]... [--lamport N] [--message M]
  maint branch  NAME [--from VERSION]
  maint merge   --branch B --from BRANCH [--resolve doc.field=value]... [--lamport N]
  maint undo    --branch B --version V [--lamport N]
  maint query   --phrase PHRASE [--as-of VERSION] [--branch B]
  maint compact
options:
  --store PATH   store file (default: ${DEFAULT_STORE})`;

// Run one CLI invocation. Returns { code, out, err } without touching
// process.stdout / process.exit, so it is testable in-process.
export function runCli(argv) {
  const out = [];
  const err = [];
  try {
    const code = dispatch(argv, out);
    return { code, out: out.join('\n') + (out.length ? '\n' : ''), err: '' };
  } catch (e) {
    if (e instanceof StoreError) {
      err.push(`${e.code}: ${e.message}`);
      if (e.code === 'E_CONFLICT' && Array.isArray(e.conflicts)) {
        for (const c of e.conflicts) {
          err.push(`  conflict ${c.key}: ours=${JSON.stringify(c.ours)} theirs=${JSON.stringify(c.theirs)}`);
        }
      }
      return { code: 1, out: out.join('\n') + (out.length ? '\n' : ''), err: err.join('\n') + '\n' };
    }
    throw e;
  }
}

function dispatch(argv, out) {
  const args = parseArgs(argv);
  const cmd = args._[0];
  const storePath = one(args, 'store') || DEFAULT_STORE;
  if (!cmd || cmd === 'help') {
    out.push(USAGE);
    return cmd ? 0 : 1;
  }

  const store = existsSync(storePath)
    ? Store.fromJSON(JSON.parse(readFileSync(storePath, 'utf8')))
    : new Store();
  let dirty = false;

  switch (cmd) {
    case 'branch': {
      const name = args._[1];
      if (!name) throw new StoreError('E_VERSION', 'branch name required');
      const from = one(args, 'from');
      store.createBranch(name, from === undefined || from === true ? null : from);
      dirty = true;
      out.push(`branch ${name} -> ${store.branchHead(name) ?? '(empty)'}`);
      break;
    }
    case 'commit': {
      const branch = one(args, 'branch');
      if (!branch || branch === true) throw new StoreError('E_VERSION', '--branch required');
      const ops = [];
      for (const spec of args.set || []) {
        if (spec === true) continue;
        const { doc, field, value } = parseSet(spec);
        ops.push({ op: 'set', doc, field, value });
      }
      for (const doc of args.delete || []) {
        if (doc === true) continue;
        ops.push({ op: 'delete', doc });
      }
      const message = one(args, 'message');
      const v = store.commit({
        branch,
        ops,
        lamport: parseLamport(args),
        message: message === true || message === undefined ? '' : message,
      });
      dirty = true;
      out.push(`${v.id} lamport=${v.lamport} branch=${branch} parents=[${v.parents.join(',')}]`);
      break;
    }
    case 'merge': {
      const branch = one(args, 'branch');
      const from = one(args, 'from');
      if (!branch || branch === true || !from || from === true) {
        throw new StoreError('E_VERSION', '--branch and --from required');
      }
      const resolutions = {};
      for (const spec of args.resolve || []) {
        if (spec === true) continue;
        const { doc, field, value } = parseSet(spec);
        resolutions[`${doc}.${field}`] = value;
      }
      const v = store.merge({ branch, from, resolutions, lamport: parseLamport(args) });
      if (v === null) {
        out.push('already up to date');
      } else {
        dirty = true;
        out.push(`${v.id} lamport=${v.lamport} merge parents=[${v.parents.join(',')}]`);
      }
      break;
    }
    case 'undo': {
      const branch = one(args, 'branch');
      const version = one(args, 'version');
      if (!branch || branch === true || !version || version === true) {
        throw new StoreError('E_VERSION', '--branch and --version required');
      }
      const v = store.undo({ branch, version, lamport: parseLamport(args) });
      dirty = true;
      out.push(`${v.id} lamport=${v.lamport} undo of ${version}`);
      break;
    }
    case 'query': {
      const phrase = one(args, 'phrase');
      if (!phrase || phrase === true) throw new StoreError('E_VERSION', '--phrase required');
      let asOf = one(args, 'as-of');
      if (asOf === undefined || asOf === true) {
        const branch = one(args, 'branch') || 'main';
        asOf = store.branchHead(branch);
        if (!asOf) throw new StoreError('E_VERSION', `branch ${branch} has no versions`);
      }
      const hits = store.query(phrase, { asOf });
      const docs = store.materialize(asOf);
      for (const doc of hits) out.push(`${doc}\t${JSON.stringify(docs.get(doc))}`);
      break;
    }
    case 'compact': {
      const n = store.compact();
      dirty = true;
      out.push(`compacted to ${n} postings in 1 segment`);
      break;
    }
    default:
      out.push(USAGE);
      return 1;
  }

  if (dirty) writeFileSync(storePath, JSON.stringify(store.toJSON(), null, 2));
  return 0;
}

// Entry point: only when executed directly, not when imported by tests.
const invokedAs = process.argv[1] ? new URL(`file://${process.argv[1]}`).href : '';
if (import.meta.url === invokedAs) {
  const { code, out, err } = runCli(process.argv.slice(2));
  if (out) process.stdout.write(out);
  if (err) process.stderr.write(err);
  process.exit(code);
}
