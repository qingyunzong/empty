#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { scanDir } = require('./lib/scan');
const { loadState, mergeStates } = require('./lib/state');
const { computeChanges, ERR_TOMBSTONE_RESURRECTION } = require('./lib/diff');
const { makePlan } = require('./lib/plan');
const { applyPlan, SyncError } = require('./lib/apply');
const { resolveConflict } = require('./lib/resolve');
const { normalizeKey } = require('./lib/keys');

function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) opts[k] = argv[++i];
      else opts[k] = true;
    } else opts._.push(a);
  }
  return opts;
}

function buildDiff(aDir, bDir) {
  const scanA = scanDir(aDir);
  const scanB = scanDir(bDir);
  const state = mergeStates(loadState(aDir), loadState(bDir));
  return computeChanges(scanA, scanB, state);
}

// Returns exit code. io: {out(s), err(s)} injectable for tests.
function run(argv, io = { out: (s) => process.stdout.write(s), err: (s) => process.stderr.write(s) }) {
  const [cmd, ...rest] = argv;
  const opts = parseArgs(rest);
  const fail = (msg, code = 2) => { io.err(`error: ${msg}\n`); return code; };

  if (cmd === 'diff') {
    if (!opts.a || !opts.b) return fail('diff requires --a DIR --b DIR');
    const diff = buildDiff(opts.a, opts.b);
    const actionable = diff.changes.filter((c) => c.op !== 'none');
    io.out(JSON.stringify({ a: opts.a, b: opts.b, changes: actionable, conflicts: diff.conflicts, errors: diff.errors }, null, 2) + '\n');
    return diff.errors.length ? ERR_TOMBSTONE_RESURRECTION : 0;
  }

  if (cmd === 'plan') {
    if (!opts.a || !opts.b) return fail('plan requires --a DIR --b DIR');
    const diff = buildDiff(opts.a, opts.b);
    const plan = makePlan(opts.a, opts.b, diff);
    const out = JSON.stringify(plan, null, 2) + '\n';
    if (opts.out) fs.writeFileSync(opts.out, out);
    io.out(out);
    return plan.errors.length ? ERR_TOMBSTONE_RESURRECTION : 0;
  }

  if (cmd === 'apply') {
    let plan;
    let journalPath;
    if (opts.plan) {
      plan = JSON.parse(fs.readFileSync(opts.plan, 'utf8'));
      journalPath = `${opts.plan}.journal.json`;
    } else if (opts.a && opts.b) {
      const diff = buildDiff(opts.a, opts.b);
      plan = makePlan(opts.a, opts.b, diff);
      journalPath = path.join(opts.a, '.sync', 'apply-journal.json');
    } else {
      return fail('apply requires --plan FILE or --a DIR --b DIR');
    }
    try {
      const stats = applyPlan(plan, {
        journalPath,
        chunkSize: opts['chunk-size'] ? Number(opts['chunk-size']) : undefined,
        chunkDelayMs: opts['chunk-delay-ms'] ? Number(opts['chunk-delay-ms']) : 0,
      });
      io.out(JSON.stringify({ planHash: plan.planHash, ...stats }, null, 2) + '\n');
      return 0;
    } catch (err) {
      if (err instanceof SyncError) return fail(err.message, err.code);
      throw err;
    }
  }

  if (cmd === 'resolve') {
    if (!opts.a || !opts.b) return fail('resolve requires --a DIR --b DIR');
    if (opts.list) {
      const diff = buildDiff(opts.a, opts.b);
      io.out(JSON.stringify(diff.conflicts, null, 2) + '\n');
      return 0;
    }
    if (!opts.key || !opts.winner) return fail('resolve requires --key KEY --winner a|b (or --list)');
    if (opts.winner !== 'a' && opts.winner !== 'b') return fail('--winner must be a or b');
    try {
      const result = resolveConflict(opts.a, opts.b, normalizeKey(opts.key), opts.winner);
      io.out(JSON.stringify(result, null, 2) + '\n');
      return 0;
    } catch (err) {
      if (err instanceof SyncError) return fail(err.message, err.code);
      return fail(err.message);
    }
  }

  return fail(`unknown command: ${cmd || '(none)'}; expected diff|plan|apply|resolve`);
}

if (require.main === module) {
  process.exit(run(process.argv.slice(2)));
}

module.exports = { run };
