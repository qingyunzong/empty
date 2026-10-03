#!/usr/bin/env node
'use strict';

const fs = require('fs');
const { guard, project, projectionOf } = require('./lib/model');
const { applyConcurrent } = require('./lib/conflict');
const { cert } = require('./lib/cert');

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        args[key] = argv[i + 1];
        i += 1;
      } else {
        args[key] = true;
      }
    } else {
      args._.push(argv[i]);
    }
  }
  return args;
}

function readLog(file) {
  if (!file || !fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line));
}

function usage() {
  console.error(`usage:
  node cli.js project --log events.jsonl
  node cli.js guard   --log events.jsonl --event '<json>' [--apply]
  node cli.js cert    --log events.jsonl [--out cert.json]`);
  process.exit(2);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];
  if (!command) usage();

  if (command === 'project') {
    const state = project(readLog(args.log));
    console.log(JSON.stringify(projectionOf(state), null, 2));
    return;
  }

  if (command === 'guard') {
    if (!args.event) {
      console.error('guard requires --event');
      process.exit(2);
    }
    const event = JSON.parse(args.event);
    const state = project(readLog(args.log));
    if (args.apply) {
      const res = applyConcurrent(state, event);
      if (!res.ok) {
        console.log(JSON.stringify(res, null, 2));
        process.exit(1);
      }
      fs.appendFileSync(args.log, `${JSON.stringify(event)}\n`);
      console.log(JSON.stringify({ ok: true, seq: res.seq }));
      return;
    }
    const g = guard(state, event);
    console.log(JSON.stringify(g, null, 2));
    if (!g.ok) process.exit(1);
    return;
  }

  if (command === 'cert') {
    const state = project(readLog(args.log));
    const c = cert(state);
    const out = JSON.stringify(c, null, 2);
    if (args.out) fs.writeFileSync(args.out, `${out}\n`);
    console.log(out);
    return;
  }

  usage();
}

main();
