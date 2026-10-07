#!/usr/bin/env node
/**
 * JSONL CLI for the maintenance planner.
 *
 * Usage:
 *   node cli.js [commands.jsonl]      (reads stdin when no file is given)
 *
 * Input, one JSON object per line:
 *   {"op":"add_task","id":"t1","dur":2,"cost":30}
 *   {"op":"dep","a":"t1","b":"t2"}
 *   {"op":"group_begin"} | {"op":"group_end"} | {"op":"commit"}
 *   {"op":"rollback","level":1}
 *   {"op":"schedule","budget":100}
 *
 * Output: one JSON result per input line.
 */
import readline from 'node:readline';
import fs from 'node:fs';
import { runJsonl } from './src/cliCore.js';

async function readAll(stream) {
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let text = '';
  for await (const line of rl) text += `${line}\n`;
  return text;
}

const file = process.argv[2];
const text = file ? fs.readFileSync(file, 'utf8') : await readAll(process.stdin);
for (const line of runJsonl(text)) console.log(line);
