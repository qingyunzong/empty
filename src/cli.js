#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const store = require('./store');
const { computeSchedule, bytesPerTask } = require('./scheduler');

const EXIT_VALIDATION = 9; // negative elevation, rate over link, undo of confirmed bytes
const EXIT_USAGE = 2;
const EXIT_CORRUPT = 1;

class CliError extends Error {
  constructor(msg, code) {
    super(msg);
    this.code = code;
  }
}

function die(msg, code) {
  throw new CliError(msg, code);
}

function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) opts[k] = argv[++i];
      else opts[k] = true;
    } else {
      opts._.push(a);
    }
  }
  return opts;
}

function num(opts, key, { required = true } = {}) {
  const v = opts[key];
  if (v === undefined || v === true) {
    if (required) die(`missing --${key}`, EXIT_USAGE);
    return undefined;
  }
  const n = Number(v);
  if (!Number.isFinite(n)) die(`--${key} must be a number`, EXIT_USAGE);
  return n;
}

function loadState(dir) {
  let records;
  try {
    records = store.readJournal(dir);
  } catch (e) {
    if (e instanceof store.JournalCorruptError) die(e.message, EXIT_CORRUPT);
    throw e;
  }
  return { records, state: store.replay(records) };
}

function maybeConfig(dir, opts, state) {
  const config = {};
  if (opts.setup !== undefined) config.setup = num(opts, 'setup');
  if (opts['max-rate'] !== undefined) config.maxRate = num(opts, 'max-rate');
  if (Object.keys(config).length) {
    store.appendEntry(dir, { cmd: 'config', config });
    Object.assign(state.config, config);
  }
}

function cmdPass(dir, opts, io) {
  const sub = opts._[0];
  if (sub === 'add') {
    const { state } = loadState(dir);
    maybeConfig(dir, opts, state);
    const id = opts.id;
    const taskId = opts.task;
    if (!id || id === true) die('missing --id', EXIT_USAGE);
    if (!taskId || taskId === true) die('missing --task', EXIT_USAGE);
    if (state.passes[id]) die(`pass '${id}' already exists`, EXIT_USAGE);
    const start = num(opts, 'start');
    const end = num(opts, 'end');
    const elev = num(opts, 'elev');
    const rate = num(opts, 'rate');
    const onboard = num(opts, 'onboard');
    if (elev < 0) die(`negative elevation ${elev}`, EXIT_VALIDATION);
    if (rate <= 0) die('rate must be positive', EXIT_USAGE);
    if (rate > state.config.maxRate) {
      die(`rate ${rate} exceeds link max ${state.config.maxRate}`, EXIT_VALIDATION);
    }
    if (!(end > start)) die('end must be greater than start', EXIT_USAGE);
    if (onboard < 0) die('onboard must be non-negative', EXIT_USAGE);
    const task = { id: taskId };
    if (opts.quota !== undefined) task.quota = num(opts, 'quota');
    if (opts.min !== undefined) task.min = num(opts, 'min');
    if (opts.priority !== undefined) task.priority = num(opts, 'priority');
    const pass = { id, taskId, start, end, elev, rate, onboard };
    const rec = store.appendEntry(dir, { cmd: 'pass_add', pass, task });
    io.out({ ok: true, seq: rec.seq, hash: rec.hash, pass });
    return 0;
  }
  if (sub === 'confirm') {
    const { state } = loadState(dir);
    const id = opts.id;
    if (!id || id === true) die('missing --id', EXIT_USAGE);
    const pass = state.passes[id];
    if (!pass) die(`unknown pass '${id}'`, EXIT_USAGE);
    const result = computeSchedule(state);
    const a = result.assignments[id];
    if (!a || a.bytes <= 0) die(`pass '${id}' has no scheduled bytes to confirm`, EXIT_USAGE);
    if (a.locked) die(`pass '${id}' already confirmed`, EXIT_USAGE);
    const rec = store.appendEntry(dir, {
      cmd: 'confirm', passId: id, start: a.start, txLen: a.txLen, bytes: a.bytes,
    });
    io.out({ ok: true, seq: rec.seq, hash: rec.hash, confirmed: { passId: id, ...a } });
    return 0;
  }
  if (sub === 'list') {
    const { state } = loadState(dir);
    io.out({ passes: Object.values(state.passes), tasks: state.tasks });
    return 0;
  }
  die(`unknown pass subcommand '${sub || ''}' (add|confirm|list)`, EXIT_USAGE);
}

function cmdSchedule(dir, opts, io) {
  const { state } = loadState(dir);
  maybeConfig(dir, opts, state);
  const result = computeSchedule(state);
  const summary = {
    totalBytes: result.totalBytes,
    loss: {
      weather: result.loss.weather, conflict: result.loss.conflict,
      quota: result.loss.quota, pending: result.loss.pending,
    },
    byPass: result.loss.byPass,
    assignments: result.assignments,
  };
  const rec = store.appendEntry(dir, { cmd: 'schedule', result: summary });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'timeline.json'), JSON.stringify(result.timeline, null, 2) + '\n');
  io.out({ ...summary, timeline: result.timeline, hash: rec.hash, seq: rec.seq });
  return 0;
}

function cmdCorrect(dir, opts, io) {
  const { state } = loadState(dir);
  const id = opts.id;
  if (!id || id === true) die('missing --id', EXIT_USAGE);
  const pass = state.passes[id];
  if (!pass) die(`unknown pass '${id}'`, EXIT_USAGE);
  const start = num(opts, 'start');
  const end = num(opts, 'end');
  if (!(end > start)) die('end must be greater than start', EXIT_USAGE);
  if (pass.confirmed && pass.confirmed.bytes > 0) {
    const c = pass.confirmed;
    if (c.start < start || c.start + c.txLen > end) {
      die(`correction would invalidate confirmed bytes of pass '${id}'`, EXIT_USAGE);
    }
  }
  const before = bytesPerTask(computeSchedule(state));
  const rec = store.appendEntry(dir, {
    cmd: 'correct', passId: id, start, end, pending: !!opts.pending,
  });
  const { state: state2 } = loadState(dir);
  const result = computeSchedule(state2);
  const after = bytesPerTask(result);
  const affected = [];
  for (const t of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if ((before[t] || 0) !== (after[t] || 0)) affected.push(t);
  }
  io.out({
    ok: true, seq: rec.seq, hash: rec.hash, passId: id, window: { start, end },
    affectedTasks: affected.sort(), bytesPerTask: after,
  });
  return 0;
}

function cmdDrop(dir, opts, io) {
  const { state } = loadState(dir);
  const id = opts.id;
  if (!id || id === true) die('missing --id', EXIT_USAGE);
  const pass = state.passes[id];
  if (!pass) die(`unknown pass '${id}'`, EXIT_USAGE);
  const reason = opts.reason;
  if (!['weather', 'conflict', 'quota'].includes(reason)) {
    die('--reason must be weather|conflict|quota', EXIT_USAGE);
  }
  const pending = !!opts.pending;
  const rec = store.appendEntry(dir, { cmd: 'drop', passId: id, reason, pending });
  const { state: state2 } = loadState(dir);
  const result = computeSchedule(state2);
  io.out({
    ok: true, seq: rec.seq, hash: rec.hash, passId: id, reason, pending,
    loss: {
      weather: result.loss.weather, conflict: result.loss.conflict,
      quota: result.loss.quota, pending: result.loss.pending,
    },
    byPass: result.loss.byPass,
  });
  return 0;
}

function cmdUndo(dir, opts, io) {
  const { records } = loadState(dir);
  const len = records.length;
  let target;
  if (opts.to !== undefined) {
    target = num(opts, 'to');
  } else {
    const steps = opts.steps !== undefined ? num(opts, 'steps') : 1;
    target = len - steps;
  }
  if (!Number.isInteger(target) || target < 0 || target > len) {
    die(`invalid undo target ${target}`, EXIT_USAGE);
  }
  if (target === len) die('nothing to undo', EXIT_USAGE);
  // Undo must land on a pass boundary: position 0 or right after a
  // pass_add / schedule entry.
  if (target > 0) {
    const prevCmd = records[target - 1].entry.cmd;
    if (prevCmd !== 'pass_add' && prevCmd !== 'schedule') {
      die(`undo target ${target} is not a pass boundary`, EXIT_USAGE);
    }
  }
  const removed = records.slice(target);
  // Undoing confirmed bytes is forbidden.
  if (removed.some((r) => r.entry.cmd === 'confirm')) {
    die('cannot undo confirmed bytes', EXIT_VALIDATION);
  }
  const keptState = store.replay(records.slice(0, target));
  for (const p of Object.values(keptState.passes)) {
    if (p.confirmed && p.confirmed.bytes > 0) {
      die('cannot undo confirmed bytes', EXIT_VALIDATION);
    }
  }
  store.truncateJournal(dir, target);
  const rec = store.appendEntry(dir, { cmd: 'undo', from: len, to: target });
  io.out({ ok: true, undone: len - target, to: target, seq: rec.seq, hash: rec.hash });
  return 0;
}

function cmdVerify(dir, io) {
  const res = store.verify(dir);
  if (res.ok) {
    io.out({ ok: true, entries: res.entries });
    return 0;
  }
  io.out({ ok: false, recovered: true, removed: res.removed, entries: res.entries });
  return EXIT_CORRUPT;
}

// Runs the CLI. Returns the exit code. `io` has out(obj) and err(msg).
function run(argv, io) {
  const opts = parseArgs(argv);
  const dir = opts.dir && opts.dir !== true ? opts.dir : (process.env.GS_DIR || '.gs');
  const cmd = opts._[0];
  opts._ = opts._.slice(1);
  try {
    switch (cmd) {
      case 'pass': return cmdPass(dir, opts, io);
      case 'schedule': return cmdSchedule(dir, opts, io);
      case 'correct': return cmdCorrect(dir, opts, io);
      case 'drop': return cmdDrop(dir, opts, io);
      case 'undo': return cmdUndo(dir, opts, io);
      case 'verify': return cmdVerify(dir, io);
      default:
        die('usage: cli.js [--dir DIR] <pass|schedule|correct|drop|undo|verify> ...', EXIT_USAGE);
    }
  } catch (e) {
    if (e instanceof CliError) {
      io.err(`error: ${e.message}`);
      return e.code;
    }
    throw e;
  }
}

if (require.main === module) {
  const code = run(process.argv.slice(2), {
    out: (obj) => process.stdout.write(JSON.stringify(obj, null, 2) + '\n'),
    err: (msg) => process.stderr.write(msg + '\n'),
  });
  process.exit(code);
}

module.exports = { run, EXIT_VALIDATION, EXIT_USAGE, EXIT_CORRUPT };
