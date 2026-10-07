#!/usr/bin/env node
'use strict';

const fs = require('fs');
const { Store } = require('./src/store');
const { bruteForce, plansMatch, MAX_BRUTE_FORCE_JOBS } = require('./src/verify');
const { SchedError } = require('./src/errors');

const EXIT_CODES = {
  E_INFEASIBLE: 2,
  E_SNAPSHOT: 3,
  E_INVALID: 4,
  E_CORRUPT: 5,
  E_UNSUPPORTED: 6,
};

const USAGE = `Usage: node cli.js <command> [--db DIR] [options]

Commands:
  set-jobs --file jobs.json   Replace the job set (input: {jobs:[...], devices?:[...]})
  jobs                        Show the current job set and jobsVersion
  plan                        Solve, stage and commit a new plan version
  current                     Show the currently visible committed plan
  lookup --job J --device D   Secondary-index lookup on (jobId, deviceId)
  verify                      Cross-check the current plan against an
                              independent exhaustive DFS (<= ${MAX_BRUTE_FORCE_JOBS} jobs)
  recover                     Re-run WAL recovery and show the recovered state

Crash injection: SCHED_CRASH=after_stage|after_commit node cli.js plan --db DIR
Exit codes: 0 ok, 2 E_INFEASIBLE, 3 E_SNAPSHOT, 4 E_INVALID, 5 E_CORRUPT, 6 E_UNSUPPORTED`;

function parseArgs(argv) {
  const opts = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) opts[key] = argv[++i];
      else opts[key] = true;
    } else {
      positional.push(a);
    }
  }
  return { command: positional[0], opts };
}

function out(obj) {
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
}

function readInput(file) {
  const text = file ? fs.readFileSync(file, 'utf8') : fs.readFileSync(0, 'utf8');
  return JSON.parse(text);
}

function main() {
  const { command, opts } = parseArgs(process.argv.slice(2));
  if (!command || command === 'help' || opts.help) {
    out({ ok: true, usage: USAGE });
    return;
  }
  const db = opts.db || './sched-data';
  const crashEnv = process.env.SCHED_CRASH;
  const crashHook = crashEnv
    ? (point) => {
        if (point === crashEnv) process.exit(99);
      }
    : null;
  const store = Store.open(db, { crashHook });

  switch (command) {
    case 'set-jobs': {
      const input = readInput(opts.file);
      const jobsVersion = store.setJobs(input);
      out({ ok: true, jobsVersion });
      return;
    }
    case 'jobs': {
      out({ ok: true, ...store.getJobs() });
      return;
    }
    case 'plan': {
      const { version, plan } = store.planAndCommit();
      out({ ok: true, version, plan });
      return;
    }
    case 'current': {
      const cur = store.current();
      out({ ok: true, version: cur ? cur.version : 0, plan: cur ? cur.plan : null });
      return;
    }
    case 'lookup': {
      if (!opts.job || !opts.device) throw new SchedError('E_INVALID', 'lookup requires --job and --device');
      out({ ok: true, entry: store.lookup(opts.job, opts.device) });
      return;
    }
    case 'verify': {
      const cur = store.current();
      if (!cur) throw new SchedError('E_INVALID', 'no committed plan to verify');
      const { jobs, devices } = store.getJobs();
      const expected = bruteForce({ jobs, devices });
      const result = plansMatch(cur.plan, expected);
      out({ ok: result.match, version: cur.version, diffs: result.diffs, certificate: cur.plan.certificate, dfs: expected.certificate });
      if (!result.match) process.exit(1);
      return;
    }
    case 'recover': {
      out({ ok: true, jobsVersion: store.jobsVersion, currentVersion: store.currentVersion });
      return;
    }
    default:
      throw new SchedError('E_INVALID', `unknown command: ${command}`);
  }
}

try {
  main();
} catch (err) {
  const code = err instanceof SchedError ? err.code : 'E_INTERNAL';
  out({
    ok: false,
    error: {
      code,
      message: err.message,
      ...(err.details !== undefined ? { details: err.details } : {}),
    },
  });
  process.exit(EXIT_CODES[code] || 1);
}
