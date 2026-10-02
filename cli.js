#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const { Store, StoreError } = require('./lib/store');

const USAGE = `usage: node cli.js <command> --store <file> [options]

commands:
  commit  --branch B --doc D --set field=value [--set ...] [--del field] [--clock N] [--message M]
  branch  --name B --from <version|branch>
  merge   --into B1 --from B2 [--resolve doc.field=value] [--clock N]
  undo    --branch B --version V [--clock N]
  query   --phrase P [--as-of V | --branch B]

error codes: E_CLOCK (bad lamport clock), E_CONFLICT (unresolved merge
conflict), E_VERSION (unknown version/branch)`;

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) throw new Error(`unexpected argument: ${arg}`);
    const key = arg.slice(2);
    const value = argv[++i];
    if (value === undefined) throw new Error(`missing value for --${key}`);
    if (opts[key] === undefined) opts[key] = value;
    else if (Array.isArray(opts[key])) opts[key].push(value);
    else opts[key] = [opts[key], value];
  }
  return opts;
}

function asList(value) {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function asClock(value) {
  return value === undefined ? undefined : Number(value);
}

function loadStore(path) {
  if (fs.existsSync(path) && fs.statSync(path).size > 0) {
    return Store.fromJSON(JSON.parse(fs.readFileSync(path, 'utf8')));
  }
  return new Store();
}

function saveStore(path, store) {
  fs.writeFileSync(path, JSON.stringify(store.toJSON(), null, 2));
}

// Runs one CLI invocation. Returns {status, stdout, stderr} so it can be
// driven both from the shell wrapper below and from tests in-process.
function run(argv) {
  const stdout = [];
  const stderr = [];
  const emit = (line) => stdout.push(line);
  const fail = (line) => stderr.push(line);

  try {
    const [command, ...rest] = argv;
    if (!command || command === 'help') {
      emit(USAGE);
      return { status: command ? 0 : 2, stdout: stdout.join('\n') + '\n', stderr: '' };
    }
    const opts = parseArgs(rest);
    const storePath = opts.store || 'workorders.store.json';
    const store = loadStore(storePath);

    switch (command) {
      case 'commit': {
        if (!opts.doc) throw new Error('commit requires --doc');
        const ops = [];
        for (const kv of asList(opts.set)) {
          const i = kv.indexOf('=');
          if (i < 0) throw new Error(`invalid --set (want field=value): ${kv}`);
          ops.push({ type: 'set', doc: opts.doc, field: kv.slice(0, i), value: kv.slice(i + 1) });
        }
        for (const field of asList(opts.del)) {
          ops.push({ type: 'del', doc: opts.doc, field });
        }
        const version = store.commit({
          branch: opts.branch || 'main',
          ops,
          clock: asClock(opts.clock),
          message: opts.message,
        });
        saveStore(storePath, store);
        emit(JSON.stringify(version, null, 2));
        break;
      }
      case 'branch': {
        if (!opts.name || !opts.from) throw new Error('branch requires --name and --from');
        const result = store.createBranch(opts.name, opts.from);
        saveStore(storePath, store);
        emit(JSON.stringify(result, null, 2));
        break;
      }
      case 'merge': {
        if (!opts.from) throw new Error('merge requires --from');
        const resolutions = {};
        for (const rv of asList(opts.resolve)) {
          const eq = rv.indexOf('=');
          const dot = rv.lastIndexOf('.', eq < 0 ? rv.length : eq);
          if (eq < 0 || dot < 0) {
            throw new Error(`invalid --resolve (want doc.field=value): ${rv}`);
          }
          resolutions[`${rv.slice(0, dot)}.${rv.slice(dot + 1, eq)}`] = rv.slice(eq + 1);
        }
        const result = store.merge({
          into: opts.into || 'main',
          from: opts.from,
          resolutions,
          clock: asClock(opts.clock),
        });
        saveStore(storePath, store);
        emit(JSON.stringify(result, null, 2));
        break;
      }
      case 'undo': {
        if (!opts.version) throw new Error('undo requires --version');
        const version = store.undo({
          branch: opts.branch || 'main',
          version: opts.version,
          clock: asClock(opts.clock),
          message: opts.message,
        });
        saveStore(storePath, store);
        emit(JSON.stringify(version, null, 2));
        break;
      }
      case 'query': {
        if (!opts.phrase) throw new Error('query requires --phrase');
        let asOf = opts['as-of'];
        if (!asOf && opts.branch) asOf = store.branches.get(opts.branch);
        if (!asOf) asOf = store.branches.get('main');
        if (!asOf) {
          throw new StoreError('E_VERSION', 'no version to query: pass --as-of or --branch');
        }
        const docs = store.queryPhrase(opts.phrase, { asOf });
        emit(JSON.stringify({ phrase: opts.phrase, asOf, docs }, null, 2));
        break;
      }
      default:
        fail(`unknown command: ${command}`);
        fail(USAGE);
        return { status: 2, stdout: '', stderr: stderr.join('\n') + '\n' };
    }
    return { status: 0, stdout: stdout.join('\n') + '\n', stderr: '' };
  } catch (err) {
    if (err instanceof StoreError) {
      fail(`${err.code}: ${err.message}`);
      if (err.details && err.details.conflicts) {
        for (const c of err.details.conflicts) {
          fail(
            `conflict: ${c.doc} ${c.field} base=${JSON.stringify(c.base)} ` +
              `ours=${JSON.stringify(c.ours)} theirs=${JSON.stringify(c.theirs)}`
          );
        }
      }
      return { status: 1, stdout: '', stderr: stderr.join('\n') + '\n' };
    }
    fail(`error: ${err.message}`);
    return { status: 2, stdout: '', stderr: stderr.join('\n') + '\n' };
  }
}

if (require.main === module) {
  const result = run(process.argv.slice(2));
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exit(result.status);
}

module.exports = { run };
