#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const { Store, CorruptionError } = require('./store');
const {
  ValidationError, applyEvent, digestOf, computePkgHash,
} = require('./core');

const EXIT_OK = 0;
const EXIT_USAGE = 2;
const EXIT_CORRUPT = 3;
const EXIT_VALIDATION = 4;

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        args[key] = argv[i + 1];
        i += 1;
      } else {
        args[key] = true;
      }
    } else {
      args._.push(a);
    }
  }
  return args;
}

function intArg(args, name, { required = false } = {}) {
  if (args[name] == null || args[name] === true) {
    if (required) throw new ValidationError('bad-request', `missing --${name}`);
    return undefined;
  }
  const v = Number(args[name]);
  if (!Number.isInteger(v)) throw new ValidationError('bad-request', `--${name} must be an integer`);
  return v;
}

function strArg(args, name, { required = false } = {}) {
  const v = args[name];
  if (v == null || v === true) {
    if (required) throw new ValidationError('bad-request', `missing --${name}`);
    return undefined;
  }
  return String(v);
}

function usage() {
  return [
    'Usage: node src/cli.js <command> [options]',
    'Commands:',
    '  init    --dir D --config config.json',
    '  submit  --dir D (--id P --tenant T --submitter S --size N --level L',
    '          --deadline N --prev-hash H --evidence-hash H --client C',
    '          --lamport N --quota-proof P | --batch file.json) [--now N]',
    '  verify  --dir D [--now N] [--fail id1,id2]',
    '  correct --dir D --pkg P --size N --evidence-hash H [--deadline N] [--now N]',
    '  recall  --dir D --pkg P [--now N]',
    '  audit   --dir D',
  ].join('\n');
}

function submitPayload(args) {
  return {
    id: strArg(args, 'id', { required: true }),
    tenant: strArg(args, 'tenant', { required: true }),
    submitter: strArg(args, 'submitter', { required: true }),
    size: intArg(args, 'size', { required: true }),
    level: intArg(args, 'level', { required: true }),
    deadline: intArg(args, 'deadline', { required: true }),
    prevHash: strArg(args, 'prev-hash', { required: true }),
    evidenceHash: strArg(args, 'evidence-hash', { required: true }),
    client: strArg(args, 'client', { required: true }),
    lamport: intArg(args, 'lamport') || 0,
    quotaProof: strArg(args, 'quota-proof', { required: true }),
  };
}

// Concurrent submissions are totally ordered by (lamport, client, hash).
function orderKey(payload) {
  const hash = computePkgHash({
    id: payload.id, version: 1, tenant: payload.tenant, submitter: payload.submitter,
    size: payload.size, level: payload.level, deadline: payload.deadline,
    evidenceHash: payload.evidenceHash, prevHash: payload.prevHash,
  });
  return [payload.lamport || 0, payload.client, hash];
}

function run(argv) {
  const args = parseArgs(argv);
  const command = args._[0];
  if (!command || args.help) {
    return { code: command ? EXIT_OK : EXIT_USAGE, stdout: usage() + '\n', stderr: '' };
  }
  const dir = strArg(args, 'dir') || process.env.EVIDENCE_DB || './.evidence-db';
  const store = new Store(dir);
  const now = intArg(args, 'now');

  if (command === 'audit') {
    const { report, digest } = store.audit();
    return { code: EXIT_OK, stdout: JSON.stringify({ ok: true, command: 'audit', report, digest }, null, 2) + '\n', stderr: '' };
  }

  if (command === 'init') {
    const configPath = strArg(args, 'config', { required: true });
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const { state, events } = store.load();
    if (events.length) throw new ValidationError('bad-request', 'database already initialized');
    const event = { type: 'init', lamport: 0, payload: config };
    const info = applyEvent(state, event);
    const entry = store.appendEvent(event);
    store.writeSnapshot(state);
    return {
      code: EXIT_OK,
      stdout: JSON.stringify({ ok: true, command: 'init', ...info, digest: digestOf(state, entry.eventHash) }, null, 2) + '\n',
      stderr: '',
    };
  }

  const { state } = store.load();
  const events = [];
  let info = {};

  if (command === 'submit') {
    let payloads;
    const batchPath = strArg(args, 'batch');
    if (batchPath) {
      payloads = JSON.parse(fs.readFileSync(batchPath, 'utf8'));
      if (!Array.isArray(payloads)) throw new ValidationError('bad-request', 'batch must be an array');
      payloads = payloads.map((p) => ({ ...p }));
      payloads.sort((a, b) => {
        const ka = orderKey(a);
        const kb = orderKey(b);
        for (let i = 0; i < 3; i += 1) {
          if (ka[i] !== kb[i]) return ka[i] < kb[i] ? -1 : 1;
        }
        return 0;
      });
    } else {
      payloads = [submitPayload(args)];
    }
    const submitted = [];
    for (const payload of payloads) {
      const event = { type: 'submit', lamport: payload.lamport || 0, payload };
      if (now != null) event.now = now;
      const r = applyEvent(state, event);
      events.push(event);
      submitted.push(r.package);
    }
    info = { submitted };
  } else if (command === 'verify') {
    const fail = strArg(args, 'fail');
    const event = {
      type: 'verify',
      lamport: 0,
      payload: { fail: fail ? fail.split(',').map((s) => s.trim()).filter(Boolean) : [] },
    };
    if (now != null) event.now = now;
    info = applyEvent(state, event);
    events.push(event);
  } else if (command === 'correct') {
    const event = {
      type: 'correct',
      lamport: 0,
      payload: {
        pkg: strArg(args, 'pkg', { required: true }),
        size: intArg(args, 'size', { required: true }),
        evidenceHash: strArg(args, 'evidence-hash', { required: true }),
        deadline: intArg(args, 'deadline'),
      },
    };
    if (now != null) event.now = now;
    info = applyEvent(state, event);
    events.push(event);
  } else if (command === 'recall') {
    const event = {
      type: 'recall',
      lamport: 0,
      payload: { pkg: strArg(args, 'pkg', { required: true }) },
    };
    if (now != null) event.now = now;
    info = applyEvent(state, event);
    events.push(event);
  } else {
    return { code: EXIT_USAGE, stdout: '', stderr: usage() + '\n' };
  }

  let lastHash = store.lastEventsHash(store.readJournal().events);
  for (const event of events) {
    lastHash = store.appendEvent(event).eventHash;
  }
  store.writeSnapshot(state);
  return {
    code: EXIT_OK,
    stdout: JSON.stringify({ ok: true, command, ...info, digest: digestOf(state, lastHash) }, null, 2) + '\n',
    stderr: '',
  };
}

// Execute one CLI invocation in-process; returns { code, stdout, stderr }.
function execute(argv) {
  try {
    return run(argv);
  } catch (err) {
    if (err instanceof ValidationError) {
      return { code: EXIT_VALIDATION, stdout: '', stderr: JSON.stringify({ ok: false, error: { code: err.code, message: err.message } }) + '\n' };
    }
    if (err instanceof CorruptionError) {
      return { code: EXIT_CORRUPT, stdout: '', stderr: JSON.stringify({ ok: false, error: { code: 'corrupt', message: err.message } }) + '\n' };
    }
    return { code: EXIT_USAGE, stdout: '', stderr: JSON.stringify({ ok: false, error: { code: 'internal', message: err.message } }) + '\n' };
  }
}

function main() {
  const r = execute(process.argv.slice(2));
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  process.exitCode = r.code;
}

if (require.main === module) main();

module.exports = { execute, run, EXIT_OK, EXIT_USAGE, EXIT_CORRUPT, EXIT_VALIDATION };
