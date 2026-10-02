#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { makeEvent, eventHash } from './event.js';
import {
  ensureStore, readIndex, readLog, appendEvent, resume as resumeStore,
  audit as auditStore, writeJsonAtomic, storePaths,
} from './store.js';
import { project } from './project.js';
import { step } from './machine.js';
import { syncStores } from './merge.js';

// 退出码: 0 成功; 2 用法/IO/存储错误; 3 领域拒绝(非法迁移/审计失败); 9 未决(pending/安全联锁冲突)
const EVENT_TYPES = new Set(['create', 'assign', 'start', 'complete', 'cancel', 'raise', 'clear']);

function fail(code, kind, message, extra = {}) {
  process.stderr.write(JSON.stringify({ error: { kind, message, ...extra } }) + '\n');
  process.exit(code);
}

function out(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) args[key] = argv[++i];
      else args[key] = true;
    } else {
      args._.push(a);
    }
  }
  return args;
}

function cmdEmit(args) {
  const { store, type, order } = args;
  if (!store || !type || !order) fail(2, 'usage', 'emit requires --store --type --order');
  if (!EVENT_TYPES.has(type)) fail(2, 'usage', `unknown event type: ${type}`);
  ensureStore(store);
  const idx = readIndex(store);
  const site = args.site ?? idx.site;
  if (!site) fail(2, 'usage', 'emit requires --site for a new store');
  if (idx.site && args.site && args.site !== idx.site) {
    fail(2, 'usage', `store is bound to site ${idx.site}`, { site: idx.site });
  }
  let data = {};
  if (args.data) {
    try {
      data = JSON.parse(args.data);
    } catch {
      fail(2, 'usage', '--data must be valid JSON');
    }
  }
  const actor = args.actor ?? null;
  const events = readLog(store).map((r) => r.event);
  const proj = project(events);
  const o = proj.orders[order];
  if (type === 'create') {
    if (o) fail(3, 'illegal-transition', `order ${order} already exists`, { reason: 'duplicate-create' });
  } else if (type === 'raise') {
    if (!o) fail(3, 'unknown-order', `order ${order} does not exist`);
    if (data.alarm === undefined) fail(2, 'usage', 'raise requires --data {"alarm":...}');
  } else if (type === 'clear') {
    if (!o) fail(3, 'unknown-order', `order ${order} does not exist`);
    const alarm = o.alarms[String(data.alarm)];
    if (!alarm || !alarm.raised) {
      fail(3, 'illegal-transition', `alarm ${data.alarm} is not raised`, { reason: 'clear-before-raise' });
    }
  } else {
    if (!o) fail(3, 'unknown-order', `order ${order} does not exist`);
    const r = step(o.status, type);
    if (!r.ok) fail(3, 'illegal-transition', r.reason, { from: o.status, to: type });
    if (type === 'complete' && Object.values(o.alarms).some((a) => a.raised)) {
      fail(3, 'illegal-transition', 'alarm-active', { order });
    }
  }
  if (!idx.site) {
    idx.site = site;
    writeJsonAtomic(storePaths(store).index, idx);
  }
  const seq = (idx.clock[site] ?? 0) + 1;
  const event = makeEvent({ site, seq, clock: idx.clock, type, order, data, actor, ts: Date.now() });
  const result = appendEvent(store, event);
  const decision = result.projection?.decisions.get(event.id);
  out({ ok: true, duplicate: result.duplicate, event, status: decision?.status ?? 'applied' });
}

function cmdApply(args) {
  const { store } = args;
  if (!store || (!args.event && !args.file)) fail(2, 'usage', 'apply requires --store and --event JSON or --file PATH');
  let event;
  try {
    event = args.file
      ? JSON.parse(fs.readFileSync(path.resolve(args.file), 'utf8'))
      : JSON.parse(args.event);
  } catch {
    fail(2, 'usage', 'event payload is not valid JSON');
  }
  if (!event || !event.id || !event.site || !event.seq || !event.type || !event.order || !event.vclock || !event.hash) {
    fail(2, 'usage', 'event is missing required fields');
  }
  if (eventHash(event) !== event.hash) fail(2, 'bad-event', 'event hash mismatch', { id: event.id });
  const result = appendEvent(store, event);
  if (result.duplicate) {
    out({ ok: true, duplicate: true, id: event.id });
    return;
  }
  const decision = result.projection.decisions.get(event.id);
  out({ ok: decision.status !== 'rejected', id: event.id, status: decision.status, reason: decision.reason ?? null });
  if (decision.status === 'rejected') process.exit(3);
  if (decision.status === 'pending' || decision.status === 'held') process.exit(9);
}

function cmdSync(args) {
  const { store, peer } = args;
  if (!store || !peer) fail(2, 'usage', 'sync requires --store and --peer');
  ensureStore(store);
  ensureStore(peer);
  const report = syncStores(store, peer);
  const blocked = report.heldCount > 0 || report.pending.length > 0;
  out({ ok: !blocked, ...report });
  if (blocked) process.exit(9);
}

function cmdResume(args) {
  const { store } = args;
  if (!store) fail(2, 'usage', 'resume requires --store');
  const report = resumeStore(store);
  out({
    ok: true,
    events: report.events,
    rebuiltIndex: report.rebuiltIndex,
    clock: report.clock,
    pending: report.pending,
    conflicts: report.conflicts,
  });
}

function cmdAudit(args) {
  const { store } = args;
  if (!store) fail(2, 'usage', 'audit requires --store');
  if (!fs.existsSync(store)) fail(2, 'io', `store not found: ${store}`);
  const report = auditStore(store);
  out(report);
  if (!report.ok) process.exit(3);
}

function main() {
  const [, , cmd, ...rest] = process.argv;
  const args = parseArgs(rest);
  try {
    switch (cmd) {
      case 'emit': return cmdEmit(args);
      case 'apply': return cmdApply(args);
      case 'sync': return cmdSync(args);
      case 'resume': return cmdResume(args);
      case 'audit': return cmdAudit(args);
      default:
        fail(2, 'usage', `unknown command: ${cmd ?? '(none)'}; expected emit|apply|sync|resume|audit`);
    }
  } catch (e) {
    if (e.code === 'CORRUPT') fail(2, 'corrupt', e.message);
    fail(2, 'internal', e.message);
  }
}

main();
