#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  RecallGraph,
  DomainError,
  applyEvent,
  verifyCertificate,
  EXIT_DOMAIN_ERROR,
} from './lib.js';

/** Run a trace (array of parsed events). Returns { code, out, err }. */
export function runTrace(events, { verify = false } = {}) {
  const out = [];
  const err = [];
  const graph = new RecallGraph();
  const results = [];
  try {
    for (const event of events) {
      const result = applyEvent(graph, event);
      if (result !== null) {
        results.push(result);
        out.push(JSON.stringify(result));
      }
    }
  } catch (error) {
    if (error instanceof DomainError) {
      err.push(JSON.stringify({ error: error.code, message: error.message }));
      return { code: EXIT_DOMAIN_ERROR, out, err };
    }
    throw error;
  }

  if (verify) {
    const consumed = [];
    let cursor = 0;
    let allOk = true;
    for (const result of results) {
      while (cursor < events.length && events[cursor].query === undefined) {
        consumed.push(events[cursor]);
        cursor += 1;
      }
      cursor += 1; // skip the query event itself
      const ok = result.cert === null ? true : verifyCertificate(consumed, result.cert);
      allOk = allOk && ok;
      out.push(JSON.stringify({ type: 'verify', node: result.query, ok }));
    }
    if (!allOk) return { code: 1, out, err };
  }
  return { code: 0, out, err };
}

/** Parse JSONL text into events. Throws on malformed lines. */
export function parseTrace(text) {
  const events = [];
  for (const [index, raw] of text.split('\n').entries()) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      throw new Error(`line ${index + 1}: invalid JSON`);
    }
  }
  return events;
}

function main(argv) {
  const verify = argv[0] === '--verify';
  const file = verify ? argv[1] : argv[0];
  if (!file) {
    process.stderr.write('usage: node cli.js [--verify] <trace.jsonl>\n');
    process.exit(2);
  }
  let events;
  try {
    events = parseTrace(readFileSync(file, 'utf8'));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(2);
  }
  const { code, out, err } = runTrace(events, { verify });
  for (const line of out) process.stdout.write(`${line}\n`);
  for (const line of err) process.stderr.write(`${line}\n`);
  process.exit(code);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2));
}
