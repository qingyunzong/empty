#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const { parseArgs } = require('node:util');
const { loadPolicy } = require('./policy');
const { loadEvents } = require('./store');
const { evaluate, ACTIONS } = require('./evaluate');
const { CodedError } = require('./errors');

const OPTS = {
  policy: { type: 'string' },
  events: { type: 'string' },
  tenant: { type: 'string' },
  action: { type: 'string', default: 'read' },
  at: { type: 'string' },
  audit: { type: 'string' },
  out: { type: 'string' },
  event: { type: 'string' },
};

function requireOpt(args, name) {
  if (!args[name]) throw new CodedError(2, `missing required option --${name}`);
  return args[name];
}

function deviceOf(policy, id) {
  const d = policy.devices.find((x) => x.id === id);
  if (!d) throw new CodedError(2, `unknown device '${id}'`);
  return d;
}

function appendAudit(path, entry) {
  if (path) fs.appendFileSync(path, JSON.stringify(entry) + '\n');
}

function auditEntry(args, cmd, eventId, dec) {
  const entry = {
    ts: new Date().toISOString(),
    cmd,
    tenant: args.tenant,
    action: args.action,
    at: args.at,
    event: eventId,
    decision: dec.allow ? 'allow' : 'deny',
    matchedRules: dec.matchedRules,
  };
  if (dec.brokenDeny) entry.brokenDeny = dec.brokenDeny;
  if (dec.counterexample) entry.counterexample = dec.counterexample;
  return entry;
}

function cmdQuery(args, io) {
  requireOpt(args, 'tenant');
  requireOpt(args, 'at');
  const policy = loadPolicy(requireOpt(args, 'policy'));
  const { events, marks } = loadEvents(requireOpt(args, 'events'));
  const bits = [];
  for (const ev of events) {
    const device = deviceOf(policy, ev.deviceId);
    const dec = evaluate(policy, args.tenant, ev, device, args.action, args.at);
    bits.push(dec.allow ? '1' : '0');
    const out = {
      event: ev.eventId,
      device: ev.deviceId,
      action: args.action,
      visible: dec.allow ? 1 : 0,
      falsePositive: marks.has(ev.eventId) ? 1 : 0,
    };
    if (dec.brokenDeny) out.brokenDeny = dec.brokenDeny;
    if (dec.counterexample) out.counterexample = dec.counterexample;
    io.out(JSON.stringify(out));
    appendAudit(args.audit, auditEntry(args, 'query', ev.eventId, dec));
  }
  io.out(JSON.stringify({ tenant: args.tenant, action: args.action, bitmap: bits.join('') }));
}

function cmdStats(args, io) {
  requireOpt(args, 'tenant');
  requireOpt(args, 'at');
  requireOpt(args, 'out');
  const policy = loadPolicy(requireOpt(args, 'policy'));
  const { events } = loadEvents(requireOpt(args, 'events'));
  const counts = {};
  for (const action of ACTIONS) {
    counts[action] = events.filter((ev) =>
      evaluate(policy, args.tenant, ev, deviceOf(policy, ev.deviceId), action, args.at).allow
    ).length;
  }
  // Derived statistics are immutable snapshots: appended once, never rewritten.
  const snap = { tenant: args.tenant, at: args.at, counts };
  fs.appendFileSync(args.out, JSON.stringify(snap) + '\n');
  io.out(JSON.stringify(snap));
}

function cmdMarkFp(args, io) {
  requireOpt(args, 'tenant');
  requireOpt(args, 'at');
  requireOpt(args, 'event');
  const eventsPath = requireOpt(args, 'events');
  const policy = loadPolicy(requireOpt(args, 'policy'));
  const { events, maxSeq } = loadEvents(eventsPath);
  const ev = events.find((e) => e.eventId === args.event);
  if (!ev) throw new CodedError(2, `unknown event '${args.event}'`);
  const device = deviceOf(policy, ev.deviceId);
  const dec = evaluate(policy, args.tenant, ev, device, 'mark_false_positive', args.at);
  appendAudit(args.audit, auditEntry({ ...args, action: 'mark_false_positive' }, 'mark-fp', ev.eventId, dec));
  if (!dec.allow) {
    throw new CodedError(3, `tenant '${args.tenant}' may not mark event '${args.event}' as false positive`);
  }
  // Append-only marker; the original event line is never modified. The marker
  // copies deviceId from the original event to keep mark and event consistent.
  const mark = { seq: maxSeq + 1, type: 'fp_mark', eventId: ev.eventId, deviceId: ev.deviceId, by: args.tenant, at: args.at };
  fs.appendFileSync(eventsPath, JSON.stringify(mark) + '\n');
  io.out(JSON.stringify({ marked: ev.eventId, device: ev.deviceId, by: args.tenant }));
}

// Runs one CLI command. Returns the process exit code. `io` is injectable so
// tests can capture output in-process.
function run(argv, io) {
  io = io || {
    out: (s) => console.log(s),
    // Synchronous write: process.exitCode must never truncate piped stderr.
    err: (s) => fs.writeSync(2, s + '\n'),
  };
  const [cmd, ...rest] = argv;
  try {
    const { values: args } = parseArgs({ args: rest, options: OPTS, allowPositionals: false });
    if (cmd === 'query') cmdQuery(args, io);
    else if (cmd === 'stats') cmdStats(args, io);
    else if (cmd === 'mark-fp') cmdMarkFp(args, io);
    else throw new CodedError(2, `unknown command '${cmd}'; expected query|stats|mark-fp`);
    return 0;
  } catch (err) {
    if (err instanceof CodedError) {
      io.err(`error: ${err.message}`);
      return err.code;
    }
    throw err;
  }
}

if (require.main === module) {
  process.exitCode = run(process.argv.slice(2));
}

module.exports = { run };
