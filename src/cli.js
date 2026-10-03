#!/usr/bin/env node
'use strict';

const { Database, DbError, SimulatedCrash } = require('./db');

function out(payload) {
  process.stdout.write(JSON.stringify(payload) + '\n');
}

function fail(code, message, exitCode) {
  out({ ok: false, error: { code, message } });
  process.exit(exitCode);
}

function parseArg(raw) {
  try {
    return JSON.parse(raw || '{}');
  } catch {
    fail('E_ARG', 'argument is not valid JSON', 1);
  }
}

function main() {
  const [dir, cmd, arg] = process.argv.slice(2);
  if (!dir || !cmd) {
    fail('E_USAGE', 'usage: cli.js <dbDir> <put|transfer|state|index> [json]', 1);
  }
  const opts = {};
  if (process.env.PALLET_CRASH_AT) opts.crashAt = process.env.PALLET_CRASH_AT;

  let db;
  try {
    db = Database.open(dir, opts);
  } catch (e) {
    if (e instanceof DbError && e.code === 'E_CORRUPT') fail('E_CORRUPT', e.message, 2);
    throw e;
  }

  try {
    switch (cmd) {
      case 'put': {
        const a = parseArg(arg);
        const t = db.begin();
        t.put(a.pallet, a.lot, a.quarantine === true);
        const meta = t.commit();
        out({ ok: true, ...meta });
        break;
      }
      case 'transfer': {
        const a = parseArg(arg);
        const t = db.begin();
        t.transfer(a.from, a.to, a.lots, a.quarantine);
        const meta = t.commit();
        out({ ok: true, ...meta });
        break;
      }
      case 'state':
        out({ ok: true, state: db.dump() });
        break;
      case 'index':
        out({ ok: true, index: db.dumpIndex() });
        break;
      default:
        fail('E_USAGE', `unknown command ${cmd}`, 1);
    }
  } catch (e) {
    if (e instanceof SimulatedCrash) {
      out({ ok: false, error: { code: 'E_CRASH', point: e.point } });
      process.exit(70);
    }
    if (e instanceof DbError) {
      fail(e.code, e.message, e.code === 'E_CORRUPT' ? 2 : 1);
    }
    throw e;
  }
}

main();
