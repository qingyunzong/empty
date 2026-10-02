#!/usr/bin/env node
// Offline press-shop scheduler CLI.
// stdin: a JSON array of commands (or NDJSON, one command per line).
// stdout: a single-line JSON array with one result per command.
//
// Commands:
//   {"op":"add","task":{"id","release","deadline","duration","weight"}}
//   {"op":"update","id","patch":{"release"?,"deadline"?,"duration"?,"weight"?}}
//   {"op":"remove","id"}
//   {"op":"undo"} / {"op":"redo"}
//   {"op":"solve"}  -> {ok,version,weight,jobs:[{id,start,end}],certificate}
//   {"op":"state"}  -> {ok,version,tasks:[...]}
// Rationals: "p/q", "p", integer, or {"p":..,"q":..}. Floats are rejected.
import { Scheduler } from './src/scheduler.js';
import { writeSync } from 'node:fs';

function run(commands) {
  const sched = new Scheduler();
  return commands.map((cmd) => {
    try {
      switch (cmd?.op) {
        case 'add':
          return sched.add(cmd.task);
        case 'update':
          return sched.update(cmd.id, cmd.patch ?? cmd.task ?? {});
        case 'remove':
          return sched.remove(cmd.id);
        case 'undo':
          return sched.undo();
        case 'redo':
          return sched.redo();
        case 'solve':
          return sched.solve();
        case 'state':
          return { ok: true, version: sched.version, tasks: sched.state() };
        default:
          return { ok: false, error: 'E_OP' };
      }
    } catch (e) {
      return { ok: false, error: e?.code ?? 'E_INTERNAL' };
    }
  });
}

const chunks = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('end', () => {
  const text = Buffer.concat(chunks).toString('utf8').trim();
  let commands;
  try {
    commands = JSON.parse(text);
  } catch {
    try {
      commands = text.split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
    } catch {
      writeSync(1, `${JSON.stringify({ ok: false, error: 'E_PARSE' })}\n`);
      process.exit(1);
    }
  }
  if (!Array.isArray(commands)) commands = [commands];
  writeSync(1, `${JSON.stringify(run(commands))}\n`);
});
