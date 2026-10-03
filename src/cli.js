#!/usr/bin/env node
// CLI: uptime <ingest|query|diff> [options]
//
//   uptime ingest --db state.json [--file events.json]   (stdin when no --file)
//   uptime query  --db state.json [--watermark N] [--device NAME]
//   uptime diff   OLD.json NEW.json
//
// Exit codes: 0 success, 1 schema error, 2 usage/IO error.

import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { analyzeEvents } from './analyze.js';
import { validateEvents } from './schema.js';
import { diffStores, ingestEvents, loadStore, saveStore } from './store.js';

function fail(code, message) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

function parseEventPayload(text) {
  const trimmed = text.trim();
  if (trimmed === '') return [];
  try {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    // Fall back to newline-delimited JSON.
    const events = [];
    const lines = trimmed.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i].trim();
      if (line === '') continue;
      try {
        events.push(JSON.parse(line));
      } catch {
        fail(1, `schema error: line ${i + 1} is not valid JSON`);
      }
    }
    return events;
  }
}

function cmdIngest(args) {
  const { values } = parseArgs({
    args,
    options: {
      db: { type: 'string' },
      file: { type: 'string' },
    },
  });
  if (!values.db) fail(2, 'usage: uptime ingest --db <state.json> [--file <events.json>]');
  const text = values.file
    ? readFileSync(values.file, 'utf8')
    : readFileSync(0, 'utf8');
  const events = parseEventPayload(text);
  const errors = validateEvents(events);
  if (errors.length > 0) {
    fail(1, `schema error: ${errors.join('; ')}`);
  }
  const store = loadStore(values.db);
  const summary = ingestEvents(store, events);
  saveStore(values.db, store);
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

function cmdQuery(args) {
  const { values } = parseArgs({
    args,
    options: {
      db: { type: 'string' },
      watermark: { type: 'string' },
      device: { type: 'string' },
    },
  });
  if (!values.db) fail(2, 'usage: uptime query --db <state.json> [--watermark N] [--device NAME]');
  let watermark = null;
  if (values.watermark !== undefined) {
    watermark = Number(values.watermark);
    if (!Number.isFinite(watermark)) fail(2, 'watermark must be a finite number');
  }
  const store = loadStore(values.db);
  const events = values.device
    ? store.events.filter((event) => event.device === values.device)
    : store.events;
  const report = analyzeEvents(events, { watermark });
  report.version = store.version;
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

function cmdDiff(args) {
  const { positionals } = parseArgs({ args, allowPositionals: true });
  if (positionals.length !== 2) fail(2, 'usage: uptime diff <old-state.json> <new-state.json>');
  const prev = loadStore(positionals[0]);
  const next = loadStore(positionals[1]);
  process.stdout.write(`${JSON.stringify(diffStores(prev, next), null, 2)}\n`);
}

const [command, ...rest] = process.argv.slice(2);
switch (command) {
  case 'ingest':
    cmdIngest(rest);
    break;
  case 'query':
    cmdQuery(rest);
    break;
  case 'diff':
    cmdDiff(rest);
    break;
  default:
    fail(2, 'usage: uptime <ingest|query|diff> ...');
}
