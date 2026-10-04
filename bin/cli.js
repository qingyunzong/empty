#!/usr/bin/env node
import fs from 'node:fs';
import { Store } from '../src/store.js';
import { schedule, ScheduleError } from '../src/scheduler.js';

const EXIT_OK = 0;
const EXIT_ERROR = 1;
const EXIT_USAGE = 2;
const EXIT_CRASH = 3;

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq !== -1) {
        args[arg.slice(2, eq)] = arg.slice(eq + 1);
      } else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        args[arg.slice(2)] = argv[i + 1];
        i += 1;
      } else {
        args[arg.slice(2)] = true;
      }
    } else {
      args._.push(arg);
    }
  }
  return args;
}

function emit(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

class ExitSignal extends Error {
  constructor(code) {
    super(`exit ${code}`);
    this.exitCode = code;
  }
}

function fail(err) {
  const error = { code: err.code ?? 'E_INTERNAL', message: err.message };
  for (const key of ['jobId', 'expected', 'actual']) {
    if (err[key] !== undefined) error[key] = err[key];
  }
  emit({ ok: false, error });
  throw new ExitSignal(EXIT_ERROR);
}

function usage(message) {
  emit({
    ok: false,
    error: {
      code: 'E_USAGE',
      message: `${message}. Commands: set-jobs|plan|show|query --dir D; ` +
        'set-jobs (--file F|- | --jobs JSON); plan [--expect-version N] [--crash after_stage|after_commit]; ' +
        'query --job-id J --device-id D',
    },
  });
  throw new ExitSignal(EXIT_USAGE);
}

function readJobsInput(args) {
  let text;
  if (args.jobs !== undefined) {
    text = args.jobs;
  } else if (args.file !== undefined) {
    text = args.file === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(args.file, 'utf8');
  } else {
    usage('set-jobs requires --file or --jobs');
  }
  const input = JSON.parse(text);
  return Array.isArray(input) ? { jobs: input } : input;
}

function main() {
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  const dir = typeof args.dir === 'string' ? args.dir : './data';

  switch (command) {
    case 'set-jobs': {
      const payload = readJobsInput(args);
      const store = Store.open(dir);
      try {
        const res = store.setJobs(payload.jobs ?? [], payload.devices);
        emit({ ok: true, ...res });
      } finally {
        store.close();
      }
      break;
    }
    case 'plan': {
      const store = Store.open(dir);
      try {
        if (args['expect-version'] !== undefined) {
          const expect = Number(args['expect-version']);
          if (!Number.isInteger(expect)) usage('--expect-version must be an integer');
          if (expect !== store.jobsVersion) {
            throw new ScheduleError(
              'E_SNAPSHOT',
              `expected jobs version ${expect}, current is ${store.jobsVersion}`,
              { expected: expect, actual: store.jobsVersion },
            );
          }
        }
        const tx = store.begin();
        const result = schedule(tx.jobs, tx.devices);
        const plan = {
          objective: result.objective,
          entries: result.entries,
          certificate: result.certificate,
          baseVersion: tx.jobsVersion,
        };
        store.stage(tx, plan);
        if (args.crash === 'after_stage') process.exit(EXIT_CRASH);
        const committed = store.commit(tx);
        if (args.crash === 'after_commit') process.exit(EXIT_CRASH);
        emit({ ok: true, ...committed, jobsVersion: store.jobsVersion, plan });
      } finally {
        store.close();
      }
      break;
    }
    case 'show': {
      const store = Store.open(dir);
      try {
        emit({ ok: true, ...store.getState() });
      } finally {
        store.close();
      }
      break;
    }
    case 'query': {
      if (typeof args['job-id'] !== 'string' || typeof args['device-id'] !== 'string') {
        usage('query requires --job-id and --device-id');
      }
      const store = Store.open(dir);
      try {
        const found = store.lookup(args['job-id'], args['device-id']);
        emit({ ok: true, found: found !== null, assignment: found });
      } finally {
        store.close();
      }
      break;
    }
    default:
      usage(command ? `unknown command: ${command}` : 'missing command');
  }
}

try {
  main();
} catch (err) {
  if (err instanceof ExitSignal) {
    process.exitCode = err.exitCode;
  } else if (
    err instanceof ScheduleError ||
    (err && typeof err.code === 'string' && err.code.startsWith('E_'))
  ) {
    try {
      fail(err);
    } catch (signal) {
      if (!(signal instanceof ExitSignal)) throw signal;
      process.exitCode = signal.exitCode;
    }
  } else {
    throw err;
  }
}
