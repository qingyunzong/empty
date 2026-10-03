#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const { decodeStream, decodeOne } = require('./lib/frames');
const { Engine } = require('./lib/engine');
const { Store } = require('./lib/store');

class CrashError extends Error {
  constructor(point) {
    super(`simulated crash at ${point}`);
    this.point = point;
  }
}

function parseArgs(argv) {
  const args = { state: null, file: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--state') args.state = argv[++i];
    else if (!args.file) args.file = argv[i];
    else throw Object.assign(new Error(`unexpected argument: ${argv[i]}`), { exitCode: 64 });
  }
  if (!args.file) throw Object.assign(new Error('usage: node cli.js <frames.bin> [--state <dir>]'), { exitCode: 64 });
  return args;
}

// Runs the collector. Returns {code, out, err}; never calls process.exit,
// so it is usable both as CLI entry and in-process (tests, crash recovery).
function run(argv, env = {}) {
  try {
    return { code: 0, out: collect(argv, env), err: '' };
  } catch (err) {
    if (err instanceof CrashError) return { code: 42, out: '', err: `crash: ${err.message}\n` };
    if (err && typeof err.exitCode === 'number') return { code: err.exitCode, out: '', err: `error: ${err.message}\n` };
    throw err;
  }
}

function collect(argv, env) {
  const args = parseArgs(argv);
  const stateDir = args.state || args.file + '.state';
  const window = parseInt(env.LEDGER_WINDOW || '8', 10);
  const engine = new Engine({ window });
  const store = new Store(stateDir);

  // Crash-injection hook for recovery testing (LEDGER_CRASH_POINT =
  // after-receive | after-log | after-balance | before-cert, LEDGER_CRASH_AT = n).
  const crashPoint = env.LEDGER_CRASH_POINT;
  let crashAt = parseInt(env.LEDGER_CRASH_AT || '1', 10);
  const hook = (point) => {
    if (crashPoint === point && --crashAt === 0) throw new CrashError(point);
  };

  let certified = 0;
  const publishCerts = () => {
    while (certified < engine.periods.length) {
      const period = engine.periods[certified];
      const certPath = store.certPath(period.periodId);
      store.writeCert(period.periodId, engine.certFor(period, certPath), () => hook('before-cert'));
      certified++;
    }
  };
  const sync = () => {
    if (store.syncEntries(engine.entries) > 0) hook('after-log');
    store.writeBalances(engine.balancesObj());
    hook('after-balance');
    publishCerts();
  };

  // Restart recovery: replay durably received frames through the
  // deterministic engine; sync is idempotent (entries keyed by seq,
  // identical certs skipped).
  const { inboxFrames } = store.recover();
  for (const raw of inboxFrames) engine.accept(decodeOne(raw));
  sync();

  const input = fs.readFileSync(args.file);
  const { frames, tail } = decodeStream(input);
  for (const { raw, obj } of frames) {
    store.appendInbox(raw);
    hook('after-receive');
    engine.accept(obj);
    sync();
  }
  engine.finalize();
  sync();

  const out = {
    balances: engine.balancesObj(),
    periods: engine.periods.map((p) => ({
      periodId: p.periodId,
      cutoff: p.cutoff,
      entries: p.entries.length,
      root: p.root,
      cert: store.certPath(p.periodId),
    })),
    pending: engine.pendingSnapshot,
    incompleteTailBytes: tail.length,
    verify: engine.periods.map((p) => `node verify.js ${store.certPath(p.periodId)}`),
  };
  store.close();
  return JSON.stringify(out, null, 2) + '\n';
}

if (require.main === module) {
  const r = run(process.argv.slice(2), process.env);
  if (r.out) process.stdout.write(r.out);
  if (r.err) process.stderr.write(r.err);
  process.exitCode = r.code;
}

module.exports = { run };
