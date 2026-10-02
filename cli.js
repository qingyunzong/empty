#!/usr/bin/env node
'use strict';

const { computeFee, selectRule, replay, digestEntries, bySelectionOrder, FeeError } = require('./lib/core');
const { sync, loadRules, loadTxs } = require('./lib/sync');
const { loadLedger } = require('./lib/store');

function parseArgs(argv) {
  const opts = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq >= 0) {
        opts[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const key = a.slice(2);
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
          opts[key] = next;
          i++;
        } else {
          opts[key] = true;
        }
      }
    } else {
      positional.push(a);
    }
  }
  return { opts, positional };
}

function requireOpt(opts, name) {
  if (opts[name] === undefined || opts[name] === true) {
    throw new FeeError(2, `missing required option --${name}`);
  }
  return opts[name];
}

function feeOutput(rules, tx) {
  const entry = computeFee(rules, tx);
  const sel = selectRule(rules, tx.ts);
  const candidates = sel
    ? [...sel.tied].sort(bySelectionOrder).map((r) => ({ ruleId: r.ruleId, priority: r.priority }))
    : [];
  return {
    ...entry,
    candidates,
    selected: sel ? { ruleId: sel.chosen.ruleId, priority: sel.chosen.priority } : null,
  };
}

function cmdFee(opts, out) {
  const rules = loadRules(requireOpt(opts, 'rules'));
  const txs = [];
  if (opts.tx) {
    txs.push(JSON.parse(opts.tx));
  } else if (opts['tx-file']) {
    txs.push(...loadTxs(opts['tx-file']));
  } else if (opts.amount !== undefined && opts.at !== undefined) {
    txs.push({ txId: 'adhoc', ts: Number(opts.at), amount: Number(opts.amount) });
  } else {
    throw new FeeError(2, 'fee requires --tx <json> | --tx-file <path> | --amount N --at T');
  }
  const results = txs.map((tx) => feeOutput(rules, tx));
  out(JSON.stringify(results.length === 1 ? results[0] : results) + '\n');
  return 0;
}

function cmdVerify(opts, out) {
  const rules = loadRules(requireOpt(opts, 'rules'));
  const txs = loadTxs(requireOpt(opts, 'tx'));
  const stateDir = requireOpt(opts, 'state');
  const from = Number(requireOpt(opts, 'from'));
  const to = Number(requireOpt(opts, 'to'));
  if (!(from < to)) throw new FeeError(41, `invalid interval: from (${from}) must be < to (${to})`);
  const replayed = replay(rules, txs, from, to);
  const ledger = loadLedger(stateDir);
  const ledgerEntries = [...ledger.values()].filter((e) => e.ts >= from && e.ts < to);
  const ledgerHash = digestEntries(ledgerEntries);
  const ledgerTotal = ledgerEntries.reduce((s, e) => s + e.fee, 0);
  const match = ledgerHash === replayed.hash && ledgerEntries.length === replayed.count;
  out(
    JSON.stringify({
      from,
      to,
      count: replayed.count,
      totalFee: replayed.totalFee,
      replayHash: replayed.hash,
      ledgerCount: ledgerEntries.length,
      ledgerTotalFee: ledgerTotal,
      ledgerHash,
      match,
    }) + '\n',
  );
  return match ? 0 : 1;
}

const USAGE =
  'usage: node cli.js sync --rules R --tx T --state S [--debug-crash=before-checkpoint]\n' +
  '       node cli.js fee --rules R (--tx JSON | --tx-file F | --amount N --at T)\n' +
  '       node cli.js verify --rules R --tx T --state S --from F --to T\n';

// Runs one CLI invocation. io.out / io.err receive output strings.
// Returns the process exit code (40/41 for domain errors).
function run(argv, io) {
  const { opts } = parseArgs(argv.slice(1));
  const cmd = argv[0];
  try {
    switch (cmd) {
      case 'sync': {
        const result = sync({
          rulesPath: requireOpt(opts, 'rules'),
          txPath: requireOpt(opts, 'tx'),
          stateDir: requireOpt(opts, 'state'),
          crashBeforeCheckpoint: opts['debug-crash'] === 'before-checkpoint',
        });
        io.out(JSON.stringify(result) + '\n');
        return 0;
      }
      case 'fee':
        return cmdFee(opts, io.out);
      case 'verify':
        return cmdVerify(opts, io.out);
      default:
        io.err(USAGE);
        return 2;
    }
  } catch (err) {
    const code = Number.isInteger(err.code) ? err.code : 1;
    io.err(JSON.stringify({ error: err.message, code }) + '\n');
    return code;
  }
}

if (require.main === module) {
  const code = run(process.argv.slice(2), {
    out: (s) => process.stdout.write(s),
    err: (s) => process.stderr.write(s),
  });
  if (code !== 0) process.exit(code);
}

module.exports = { run };
