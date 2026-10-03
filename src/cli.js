#!/usr/bin/env node
// CLI: reads JSON commands from stdin (a single object, a JSON array of
// commands, or newline-delimited JSON) and prints one JSON result per line.
//
// Commands:
//   {"op":"import","tasks":[{id,priority,cost:[cl,ch],duration:[dl,dh],precedence:[ids]}]}
//   {"op":"solve","budget":B,"durationLimit":L}
//   {"op":"undo"} | {"op":"redo"} | {"op":"list"}

import { runCommands } from './app.js';

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const input = Buffer.concat(chunks).toString('utf8');
for (const result of runCommands(input)) {
  process.stdout.write(JSON.stringify(result) + '\n');
}
