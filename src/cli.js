#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const { ExitError, EXIT, ACTIONS, loadPolicy } = require('./model');
const { parseEvents } = require('./events');
const { decide, visibilityBitmap } = require('./evaluate');

const USAGE = `Usage:
  node src/cli.js query --policy P.json --events E.jsonl --tenant T [--at TS] [--window W] [--audit audit.jsonl]
  node src/cli.js stats --policy P.json --events E.jsonl --tenant T [--at TS] --store stats.json [--window W]

Exit codes: 4 tenant cycle, 8 events out of order beyond window, 9 unknown tag.`;

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        args[key] = argv[++i];
      } else {
        args[key] = true;
      }
    } else {
      args._.push(a);
    }
  }
  return args;
}

function required(args, key) {
  if (args[key] === undefined || args[key] === true) {
    throw new ExitError(EXIT.GENERIC, `missing required option --${key}\n${USAGE}`);
  }
  return args[key];
}

function maxTs(events) {
  return events.reduce((m, e) => Math.max(m, e.ts), 0);
}

// Apply mark_false_positive events: a marking is applied only if the marking
// tenant held mark_false_positive permission on the target at marking time.
function computeMarkings(policy, events) {
  const byId = new Map(events.map((e) => [e.id, e]));
  const markings = new Map();
  const status = new Map();
  const auditRecords = [];
  for (const e of events) {
    if (e.type !== 'mark_false_positive') continue;
    const target = byId.get(e.target);
    if (!target) {
      status.set(e.id, 'rejected');
      auditRecords.push({ type: 'marking', event: e.id, target: e.target, by: e.tenant, applied: false, reason: 'unknown target event' });
      continue;
    }
    const d = decide(policy, e.tenant, target, 'mark_false_positive', e.ts);
    if (d.allow) {
      markings.set(e.target, { by: e.tenant, at: e.ts, markingEvent: e.id });
      status.set(e.id, 'applied');
    } else {
      status.set(e.id, 'rejected');
    }
    auditRecords.push({
      type: 'marking',
      event: e.id,
      target: e.target,
      by: e.tenant,
      applied: d.allow,
      reason: d.allow ? 'mark_false_positive permitted at marking time' : `denied: ${d.counterexample ? d.counterexample.description : 'no permission'}`,
    });
  }
  return { markings, status, auditRecords };
}

function cmdQuery(policy, events, args, io) {
  const tenant = required(args, 'tenant');
  if (!policy.tenants[tenant]) throw new ExitError(EXIT.GENERIC, `unknown tenant "${tenant}"`);
  const at = args.at !== undefined ? Number(args.at) : maxTs(events);
  const { markings, status, auditRecords } = computeMarkings(policy, events);

  const out = [];
  const audit = [{ type: 'query', tenant, at, events: events.length }];
  for (const e of events) {
    const { bitmap, allowed, denied } = visibilityBitmap(policy, tenant, e, at);
    const line = { event: e.id, tenant, bitmap, allowed, denied };
    if (e.type === 'mark_false_positive') line.markingStatus = status.get(e.id);
    const marking = markings.get(e.id);
    if (marking) line.falsePositive = marking;
    out.push(JSON.stringify(line));
    for (const action of ACTIONS) {
      const d = decide(policy, tenant, e, action, at);
      audit.push({
        type: 'decision',
        at,
        tenant,
        event: e.id,
        action,
        allow: d.allow,
        allows: d.allows,
        denies: d.denies,
        broken: d.broken,
        breakReason: d.breakReason,
        counterexample: d.counterexample,
      });
    }
  }
  audit.push(...auditRecords);
  io.stdout(out.join('\n') + '\n');
  if (args.audit) fs.writeFileSync(args.audit, audit.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

function cmdStats(policy, events, args, io) {
  const tenant = required(args, 'tenant');
  if (!policy.tenants[tenant]) throw new ExitError(EXIT.GENERIC, `unknown tenant "${tenant}"`);
  const storePath = required(args, 'store');
  const at = args.at !== undefined ? Number(args.at) : maxTs(events);

  // Derived statistics are immutable snapshots: once computed for a tenant
  // they never change, even if authorizations are later revoked. Detail
  // queries are always rebuilt at query time and DO reflect revocations.
  let store = {};
  if (fs.existsSync(storePath)) store = JSON.parse(fs.readFileSync(storePath, 'utf8'));
  if (store[tenant]) {
    io.stdout(JSON.stringify({ ...store[tenant], snapshot: true }) + '\n');
    return;
  }
  const counts = { read: 0, modify: 0, mark_false_positive: 0 };
  for (const e of events) {
    if (e.type === 'mark_false_positive') continue;
    const { bitmap } = visibilityBitmap(policy, tenant, e, at);
    if (bitmap & 1) counts.read++;
    if (bitmap & 2) counts.modify++;
    if (bitmap & 4) counts.mark_false_positive++;
  }
  const record = { tenant, computedAt: at, counts };
  store[tenant] = record;
  fs.writeFileSync(storePath, JSON.stringify(store, null, 2) + '\n');
  io.stdout(JSON.stringify({ ...record, snapshot: false }) + '\n');
}

// Runs the CLI and returns the process exit code. `io` allows tests to
// capture output in-process (child_process is not required).
function run(argv, io = {}) {
  const stdout = io.stdout || ((s) => process.stdout.write(s));
  const stderr = io.stderr || ((s) => process.stderr.write(s));
  const args = parseArgs(argv);
  const cmd = args._[0];
  try {
    if (cmd !== 'query' && cmd !== 'stats') throw new ExitError(EXIT.GENERIC, USAGE);
    const policy = loadPolicy(JSON.parse(fs.readFileSync(required(args, 'policy'), 'utf8')));
    const window = args.window !== undefined ? Number(args.window) : 300;
    const events = parseEvents(fs.readFileSync(required(args, 'events'), 'utf8'), window);
    if (cmd === 'query') cmdQuery(policy, events, args, { stdout });
    else cmdStats(policy, events, args, { stdout });
    return 0;
  } catch (err) {
    if (err instanceof ExitError) {
      stderr(`error(exit ${err.exitCode}): ${err.message}\n`);
      return err.exitCode;
    }
    throw err;
  }
}

if (require.main === module) process.exit(run(process.argv.slice(2)));

module.exports = { run, parseArgs, computeMarkings };
