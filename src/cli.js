#!/usr/bin/env node
'use strict';

/**
 * JSONL command-line interface.
 *
 * Usage: node src/cli.js [commands.jsonl]
 *   Reads one JSON command per line from the file argument, or stdin when
 *   omitted, and writes one JSON result per line to stdout. An optional
 *   "id" field on a command is echoed back on its result line.
 *
 * Commands:
 *   {"cmd":"add_edge","u":"A","v":"B","cost":5}
 *   {"cmd":"close","u":"A","v":"B"}
 *   {"cmd":"open","u":"A","v":"B"}
 *   {"cmd":"set_cost","u":"A","v":"B","cost":7}
 *   {"cmd":"query","from":"A","to":"C"}
 *   {"cmd":"undo"}
 *   {"cmd":"verify","cert":{...}}
 */

import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { AgvGraph, ERR, dispatch } from './index.js';

/**
 * Pure core: run an iterable of raw JSONL lines against a fresh graph and
 * return one result object per non-empty line. Exported for testing.
 */
export function runLines(lines, graph = new AgvGraph()) {
  const results = [];
  for (const line of lines) {
    const trimmed = String(line).trim();
    if (trimmed === '') continue;
    let cmd;
    try {
      cmd = JSON.parse(trimmed);
    } catch {
      cmd = null;
    }
    const id =
      cmd !== null && typeof cmd === 'object' && !Array.isArray(cmd) && 'id' in cmd
        ? cmd.id
        : undefined;
    const result =
      cmd === null ? { ok: false, error: ERR.INVALID_INPUT, reason: 'bad json' } : dispatch(graph, cmd);
    if (id !== undefined) result.id = id;
    results.push(result);
  }
  return results;
}

async function main() {
  const file = process.argv[2];
  const input = file ? createReadStream(file, 'utf8') : process.stdin;
  const rl = createInterface({ input, crlfDelay: Infinity });
  const lines = [];
  for await (const line of rl) lines.push(line);
  const results = runLines(lines);
  if (results.length > 0) process.stdout.write(results.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
