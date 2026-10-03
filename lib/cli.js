'use strict';

const fs = require('fs');
const store = require('./store');
const { LedgerError, CrashError } = require('./errors');

const USAGE = [
  'usage: day [--dir PATH] [--crash-at POINT] <command>',
  '  begin <date>          open a new day (YYYY-MM-DD)',
  '  add <json-entry>      append entry {id,account,amount[,type,refId]}',
  '  rewrite <plan.json>   rewrite open day: {date,dropIds,moveBefore,fixAmounts}',
  '  commit                durably commit the open day',
  '  recover               classify and repair after a crash',
  '  status                classify without repairing',
  'crash points: before-fsync | before-wal-rename | after-head-update',
].join('\n');

function parseArgs(argv, env) {
  let dir = env.DAY_DIR || '.day';
  let crashAt = env.DAY_CRASH_AT || null;
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dir') dir = argv[++i];
    else if (a === '--crash-at') crashAt = argv[++i];
    else rest.push(a);
  }
  return { dir, crashAt, cmd: rest[0], args: rest.slice(1) };
}

// Returns the process exit code. io: {out(msg), err(msg)} line writers.
function run(argv, io, env = process.env) {
  const { dir, crashAt, cmd, args } = parseArgs(argv, env);
  const statusLine = (r) => `STATUS=${r.status} evidence=${r.evidence.length ? r.evidence.join(',') : '-'}`;
  try {
    switch (cmd) {
      case 'begin': {
        if (!args[0]) throw new LedgerError('E_USAGE', 2, 'begin requires <date>');
        store.begin(dir, args[0]);
        io.out(`OK begin date=${args[0]}`);
        return 0;
      }
      case 'add': {
        if (!args[0]) throw new LedgerError('E_USAGE', 2, 'add requires <json-entry>');
        const saved = store.add(dir, JSON.parse(args[0]));
        io.out(`OK add id=${saved.id}`);
        return 0;
      }
      case 'rewrite': {
        if (!args[0]) throw new LedgerError('E_USAGE', 2, 'rewrite requires <plan.json>');
        const plan = JSON.parse(fs.readFileSync(args[0], 'utf8'));
        const next = store.rewrite(dir, plan);
        io.out(`OK rewrite entries=${next.length}`);
        return 0;
      }
      case 'commit': {
        const snap = store.commit(dir, { crashAt });
        io.out(`OK commit date=${snap.date} gen=${snap.gen} entries=${snap.entries.length}`);
        return 0;
      }
      case 'recover': {
        io.out(statusLine(store.recover(dir)));
        return 0;
      }
      case 'status': {
        io.out(statusLine(store.status(dir)));
        return 0;
      }
      default: {
        io.err(USAGE);
        return 2;
      }
    }
  } catch (e) {
    if (e instanceof CrashError) {
      io.err(`CRASH at=${e.point}`);
      return 75;
    }
    if (e instanceof LedgerError) {
      io.err(`ERROR code=${e.code} msg=${e.message}`);
      return e.exitCode;
    }
    io.err(`ERROR code=E_INTERNAL msg=${e && e.message ? e.message : e}`);
    return 2;
  }
}

module.exports = { run, USAGE };
