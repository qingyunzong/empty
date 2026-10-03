#!/usr/bin/env node
'use strict';

const { Aggregator, WINDOW_SECONDS, windowStart } = require('./src/aggregator');
const storage = require('./src/storage');

const EXIT_CRASH_AFTER_APPEND = 2;
const EXIT_CRASH_BEFORE_APPEND = 3;
const EXIT_USAGE = 64;

function usage() {
  return [
    'usage:',
    '  node cli.js append --dir D (--event JSON ... | --id I --device D --ts N --state up|down)',
    '                     [--fail-before-append | --fail-after-append]',
    '  node cli.js query  --dir D --device D --from N --to N',
    '  node cli.js compact --dir D',
  ].join('\n');
}

function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      if (key === 'fail-before-append' || key === 'fail-after-append') {
        opts[key] = true;
        continue;
      }
      if (i + 1 >= argv.length) throw new Error(`missing value for --${key}`);
      const val = argv[(i += 1)];
      if (key === 'event') (opts.event ||= []).push(val);
      else opts[key] = val;
    } else {
      opts._.push(a);
    }
  }
  return opts;
}

function validateEvent(ev) {
  if (!ev || typeof ev.id !== 'string' || !ev.id) throw new Error(`bad event id: ${JSON.stringify(ev)}`);
  if (typeof ev.device !== 'string' || !ev.device) throw new Error(`bad device in event ${ev.id}`);
  if (!Number.isInteger(ev.ts) || ev.ts < 0) throw new Error(`bad ts in event ${ev.id}`);
  if (ev.state !== 'up' && ev.state !== 'down') throw new Error(`bad state in event ${ev.id}`);
  return ev;
}

function collectEvents(opts) {
  const events = [];
  for (const raw of opts.event || []) events.push(JSON.parse(raw));
  if (opts.id !== undefined) {
    events.push({ id: opts.id, device: opts.device, ts: Number(opts.ts), state: opts.state });
  }
  if (!events.length) throw new Error('no events given');
  return events.map(validateEvent);
}

function fmtRow(r) {
  return `device=${r.device} window=${r.window} uptime=${r.uptime} downtime=${r.downtime} unknown=${r.unknown}`;
}

function correctionLines(c) {
  return [
    { type: 'retract', device: c.entry.device, window: c.entry.window, version: c.previous.version,
      uptime: c.previous.uptime, downtime: c.previous.downtime, unknown: c.previous.unknown },
    { type: 'correct', device: c.entry.device, window: c.entry.window, version: c.entry.version,
      uptime: c.entry.uptime, downtime: c.entry.downtime, unknown: c.entry.unknown },
  ];
}

function loadAggregator(dir) {
  const agg = new Aggregator();
  agg.restore(storage.loadState(dir));
  for (const ev of storage.replay(dir)) agg.addEvent(ev);
  return agg;
}

function cmdAppend(opts) {
  const dir = opts.dir || './data';
  const events = collectEvents(opts);

  if (opts['fail-before-append']) {
    process.stderr.write('fault injected: crash before append; batch discarded, log untouched\n');
    process.exit(EXIT_CRASH_BEFORE_APPEND);
  }

  storage.appendBatch(dir, events); // commit point

  if (opts['fail-after-append']) {
    process.stderr.write('fault injected: crash after append, before index update; restart must replay the log\n');
    process.exit(EXIT_CRASH_AFTER_APPEND);
  }

  const agg = loadAggregator(dir);
  const newIds = new Set(events.map((e) => e.id));
  const corrections = [];
  for (const ev of events) {
    if (!newIds.has(ev.id)) continue;
    const dev = agg.sortedEvents(ev.device);
    if (!dev.some((e) => e.id === ev.id)) continue; // duplicate, already in log
    const idx = dev.findIndex((e) => e.id === ev.id);
    const late = agg.watermark !== null && ev.ts < agg.watermark;
    if (!late) continue;
    const next = dev[idx + 1] || null;
    const rangeEnd = next ? next.ts : Infinity;
    for (const w of agg.publishedWindowsInRange(ev.device, ev.ts, rangeEnd)) {
      const c = agg.publishWindow(ev.device, w);
      if (c.kind === 'corrected') corrections.push(c);
    }
  }
  storage.saveState(dir, agg.snapshot());
  storage.appendCorrections(dir, corrections.flatMap(correctionLines));

  process.stdout.write(`appended ${events.length} event(s) to ${dir}\n`);
  for (const c of corrections) {
    process.stdout.write(`RETRACT ${fmtRow({ ...c.previous })} version=${c.previous.version}\n`);
    process.stdout.write(`CORRECT ${fmtRow(c.entry)} version=${c.entry.version}\n`);
  }
}

function cmdQuery(opts) {
  const dir = opts.dir || './data';
  if (!opts.device) throw new Error('query requires --device');
  if (opts.from === undefined || opts.to === undefined) throw new Error('query requires --from and --to');
  const from = Number(opts.from);
  const to = Number(opts.to);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) throw new Error('bad --from/--to');

  const agg = loadAggregator(dir);
  const corrections = [];
  const rows = [];
  for (let w = windowStart(from); w < to; w += WINDOW_SECONDS) {
    const r = agg.publishWindow(opts.device, w);
    if (r.kind === 'corrected') corrections.push(r);
    rows.push(r.entry);
  }
  storage.saveState(dir, agg.snapshot());
  storage.appendCorrections(dir, corrections.flatMap(correctionLines));

  for (const c of corrections) {
    process.stderr.write(`RETRACT ${fmtRow(c.previous)} version=${c.previous.version}\n`);
    process.stderr.write(`CORRECT ${fmtRow(c.entry)} version=${c.entry.version}\n`);
  }
  for (const row of rows) process.stdout.write(`${JSON.stringify(row)}\n`);
}

function cmdCompact(opts) {
  const dir = opts.dir || './data';
  const stats = storage.compact(dir);
  process.stdout.write(
    `compacted: batches=${stats.batchesBefore} events_before=${stats.eventsBefore} events_after=${stats.eventsAfter}\n`,
  );
}

function main() {
  const [, , cmd, ...rest] = process.argv;
  try {
    const opts = parseArgs(rest);
    if (cmd === 'append') cmdAppend(opts);
    else if (cmd === 'query') cmdQuery(opts);
    else if (cmd === 'compact') cmdCompact(opts);
    else {
      process.stderr.write(`${usage()}\n`);
      process.exit(EXIT_USAGE);
    }
  } catch (err) {
    process.stderr.write(`error: ${err.message}\n`);
    process.exit(EXIT_USAGE);
  }
}

main();
