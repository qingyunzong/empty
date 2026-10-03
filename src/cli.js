#!/usr/bin/env node
'use strict';

const { QuotaEngine } = require('./index');

function parseArgs(argv) {
  const args = [...argv];
  const command = args.shift();
  const options = { _: [] };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = args[i + 1];
      if (next === undefined || next.startsWith('--')) {
        options[key] = true;
      } else {
        options[key] = next;
        i++;
      }
    } else {
      options._.push(arg);
    }
  }
  return { command, options };
}

// Runs one CLI command. Returns the list of result objects (one per output
// line); also prints them as JSON lines when `emit` is set.
async function runCli(argv, { emit = null } = {}) {
  const out = [];
  const print = (value) => {
    out.push(value);
    if (emit) emit(JSON.stringify(value));
  };
  const { command, options } = parseArgs(argv);
  const wal = options.wal || 'quota.wal';
  const timeoutMs = options.timeout !== undefined ? Number(options.timeout) : 200;

  switch (command) {
    case 'init': {
      const engine = QuotaEngine.open({ walPath: wal, lockTimeoutMs: timeoutMs });
      try {
        const account = options.account;
        const balance = Number(options.balance || 0);
        const priority = Number(options.priority || 0);
        engine.addAccount(account, balance, priority);
        print({ ok: true, account, balance, priority });
      } finally {
        engine.close();
      }
      break;
    }
    case 'freeze': {
      const engine = QuotaEngine.open({ walPath: wal, lockTimeoutMs: timeoutMs });
      try {
        const txnId = engine.begin();
        const items = options._.map((spec) => {
          const [account, amount] = spec.split(':');
          return { account, amount: Number(amount) };
        });
        for (const item of items) {
          await engine.freeze(txnId, item.account, item.amount);
        }
        if (options.prepared) {
          // Journal PREPARE and stop before COMMIT (used with `crash --prepared`).
          const prepared = engine.prepare(txnId);
          print({ ok: true, state: 'prepared', ...prepared });
        } else {
          const result = await engine.commit(txnId);
          print({ ok: true, ...result });
        }
      } finally {
        engine.close();
      }
      break;
    }
    case 'cancel': {
      const engine = QuotaEngine.open({ walPath: wal, lockTimeoutMs: timeoutMs });
      try {
        const txnId = options.txn;
        const txn = engine.transactions.get(txnId);
        if (txn && (txn.state === 'active' || txn.state === 'prepared')) {
          engine.abort(txnId);
          print({ ok: true, txnId, state: 'aborted' });
        } else {
          // No live transaction (e.g. after recovery): nothing holds locks,
          // so there is nothing to roll back.
          print({ ok: true, txnId, state: 'not-active' });
        }
      } finally {
        engine.close();
      }
      break;
    }
    case 'query': {
      const engine = QuotaEngine.open({ walPath: wal, lockTimeoutMs: timeoutMs });
      try {
        const account = options.account || options._[0];
        if (account) {
          print({ ok: true, ...engine.query(account) });
        } else {
          const accounts = [...engine.accounts.keys()]
            .sort()
            .map((name) => engine.query(name));
          print({ ok: true, accounts, scan: engine.scanByPriority() });
        }
      } finally {
        engine.close();
      }
      break;
    }
    case 'crash': {
      // Simulate a crash: replay drops everything uncommitted; with
      // --prepared the caller asserts a PREPARE record is outstanding.
      const engine = QuotaEngine.open({ walPath: wal, lockTimeoutMs: timeoutMs });
      engine.crash();
      print({ ok: true, crashed: true, prepared: Boolean(options.prepared) });
      break;
    }
    default:
      throw Object.assign(
        new Error(
          'usage: quota <init|freeze|cancel|query|crash> [--wal file] [--account A] ' +
            '[--balance N] [--priority P] [account:amount ...] [--prepared] [--txn T]'
        ),
        { code: 'E_USAGE' }
      );
  }
  return out;
}

if (require.main === module) {
  runCli(process.argv.slice(2), { emit: (line) => process.stdout.write(line + '\n') }).catch(
    (err) => {
      const code = err && err.code ? err.code : 'E_INTERNAL';
      process.stdout.write(JSON.stringify({ ok: false, error: code, message: err.message }) + '\n');
      process.exitCode = 1;
    }
  );
}

module.exports = { runCli };
