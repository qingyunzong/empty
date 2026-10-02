#!/usr/bin/env node
'use strict';
const { SyncError, writeJsonSync } = require('./lib/util');
const { scan } = require('./lib/scan');
const { runApply, buildCert } = require('./lib/apply');
const { loadCheckpoint } = require('./lib/checkpoint');
const { loadDb } = require('./lib/store');

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        out[key] = argv[i + 1];
        i += 1;
      } else {
        out[key] = true;
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

function requireOpt(args, name) {
  if (args[name] === undefined || args[name] === true) {
    throw new SyncError('BAD_ARGS', `missing required option --${name}`, { option: name });
  }
  return args[name];
}

function makeCrashHook() {
  const spec = process.env.SYNC_CRASH;
  if (!spec) return null;
  const [phase, idx] = spec.split(':');
  return (p, i) => {
    if (p === phase && String(i) === String(idx)) {
      process.kill(process.pid, 'SIGKILL');
    }
  };
}

function run(argv, env = process.env) {
  const args = parseArgs(argv);
  const cmd = args._[0];
  const hook = makeCrashHook();

  switch (cmd) {
    case 'scan': {
      const journal = requireOpt(args, 'journal');
      const snapshot = requireOpt(args, 'snapshot');
      const changeset = requireOpt(args, 'changeset');
      const summary = scan({ journalPath: journal, snapshotPath: snapshot, changesetPath: changeset });
      return { code: 0, stdout: JSON.stringify({ command: 'scan', ...summary }) + '\n', stderr: '' };
    }
    case 'apply':
    case 'resume': {
      const changeset = requireOpt(args, 'changeset');
      const db = requireOpt(args, 'db');
      const checkpoint = requireOpt(args, 'checkpoint');
      const cert = args.cert || null;
      const batchSize = args.batch ? Number(args.batch) : 1000;
      if (!Number.isInteger(batchSize) || batchSize < 1) {
        throw new SyncError('BAD_ARGS', '--batch must be a positive integer', { batch: args.batch });
      }
      const result = runApply({
        changesetPath: changeset, dbPath: db, checkpointPath: checkpoint, certPath: cert,
        batchSize, resume: cmd === 'resume', hook,
      });
      return {
        code: 0,
        stdout: JSON.stringify({
          command: cmd, status: result.status, redone: result.redone,
          committedBatches: result.committedBatches, batchCount: result.batchCount,
          merkleRoot: result.cert.merkleRoot, coverage: result.cert.coverage,
        }) + '\n',
        stderr: '',
      };
    }
    case 'cert': {
      const checkpointPath = requireOpt(args, 'checkpoint');
      const dbPath = requireOpt(args, 'db');
      const certPath = requireOpt(args, 'cert');
      const checkpoint = loadCheckpoint(checkpointPath);
      if (!checkpoint) {
        throw new SyncError('NO_CHECKPOINT', `no checkpoint at ${checkpointPath}; nothing committed`, { path: checkpointPath });
      }
      const db = loadDb(dbPath);
      const cert = buildCert(checkpoint, db);
      writeJsonSync(certPath, cert);
      return { code: 0, stdout: JSON.stringify({ command: 'cert', ...cert }) + '\n', stderr: '' };
    }
    default:
      throw new SyncError('BAD_ARGS', `unknown command: ${cmd || '(none)'}; expected scan|apply|resume|cert`, {});
  }
}

function main(argv) {
  try {
    return run(argv);
  } catch (err) {
    if (err instanceof SyncError) {
      return { code: 2, stdout: '', stderr: JSON.stringify({ error: { code: err.code, message: err.message, details: err.details } }) + '\n' };
    }
    return { code: 1, stdout: '', stderr: JSON.stringify({ error: { code: 'INTERNAL', message: String((err && err.message) || err) } }) + '\n' };
  }
}

if (require.main === module) {
  const result = main(process.argv.slice(2));
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exit(result.code);
}

module.exports = { main, run };
