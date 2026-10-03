#!/usr/bin/env node
'use strict';
const fs = require('fs');
const { Store } = require('../src/store');

function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      opts._.push(a);
      continue;
    }
    const key = a.slice(2);
    const val = argv[++i];
    if (key === 'read' || key === 'write') {
      if (!opts[key]) opts[key] = [];
      opts[key].push(val);
    } else {
      opts[key] = val;
    }
  }
  return opts;
}

function fail(msg) {
  throw new CliError(msg);
}

class CliError extends Error {}

// Runs one command. Returns the exit code; output goes through io so tests
// can capture it in-process.
function run(argv, io = { out: console.log, err: console.error }) {
  const [cmd, ...rest] = argv;
  const opts = parseArgs(rest);
  try {
    if (!cmd) fail('usage: kvx <commit|read|export|import|check|replay> [--db DIR] ...');
    if (!opts.db) fail('--db DIR is required');
    return dispatch(cmd, opts, io);
  } catch (e) {
    if (e instanceof CliError) {
      io.err(`error: ${e.message}`);
      return 2;
    }
    throw e;
  }
}

function dispatch(cmd, opts, io) {
  if (cmd === 'commit') {
    const store = Store.open(opts.db, { node: opts.node });
    const writes = {};
    for (const w of opts.write || []) {
      const eq = w.indexOf('=');
      if (eq < 0) fail(`--write expects key=value, got "${w}"`);
      writes[w.slice(0, eq)] = w.slice(eq + 1);
    }
    const rec = store.commit({ reads: opts.read || [], writes });
    io.out(JSON.stringify(rec, null, 2));
    return 0;
  }

  if (cmd === 'read') {
    if (!opts.key) fail('--key is required');
    const store = Store.open(opts.db);
    const at = opts.at ? JSON.parse(opts.at) : undefined;
    const v = store.read(opts.key, at ? { at } : {});
    io.out(v === null ? '(absent)' : v);
    return 0;
  }

  if (cmd === 'export') {
    const store = Store.open(opts.db);
    const seg = store.exportSegment({ since: opts.since ? Number(opts.since) : 0 });
    if (opts.out) fs.writeFileSync(opts.out, seg);
    else process.stdout.write(seg);
    io.err(`exported ${seg.trim() ? seg.trim().split('\n').length : 0} record(s)`);
    return 0;
  }

  if (cmd === 'import') {
    if (!opts.file) fail('--file is required');
    const store = Store.open(opts.db);
    const res = store.importSegment(fs.readFileSync(opts.file, 'utf8'));
    io.out(`${res.status} imported=${res.imported} duplicates=${res.duplicates} skipped=${res.skipped}`);
    return 0;
  }

  if (cmd === 'check') {
    const store = Store.open(opts.db);
    const res = store.check();
    if (res.status === 'SERIALIZABLE') {
      io.out('SERIALIZABLE');
      io.out(`order: ${res.order.join(' -> ') || '(empty)'}`);
      return 0;
    }
    io.out('NON_SERIALIZABLE');
    if (res.cycle) io.out(`cycle: ${res.cycle.join(' -> ')}`);
    if (res.reason) io.out(`reason: ${res.reason}`);
    return 1;
  }

  if (cmd === 'replay') {
    const store = Store.open(opts.db);
    const res = store.check();
    if (res.status !== 'SERIALIZABLE') {
      io.out('NON_SERIALIZABLE');
      if (res.cycle) io.out(`cycle: ${res.cycle.join(' -> ')}`);
      return 1;
    }
    io.out(`replay order: ${res.order.join(' -> ') || '(empty)'}`);
    io.out(`state: ${JSON.stringify(res.state)}`);
    io.out('REPLAY OK (state matches merged state)');
    return 0;
  }

  fail(`unknown command: ${cmd}`);
}

if (require.main === module) {
  process.exit(run(process.argv.slice(2)));
}

module.exports = { run };
