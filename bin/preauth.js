#!/usr/bin/env node
// CLI: reads a JSONL event stream (file arg or stdin), runs the preauth
// engine, prints { timeline, violations, queue, certificates, certificatesOk }.
//
// Input: one JSON object per line. An optional config line:
//   {"type":"config","pool":100,"cards":{"c1":50},"agingK":2,"preemptWindow":2}
// Events:
//   {"type":"auth","id":"a1","card":"c1","amount":60,"priority":0,"slot":0,"expires":5}
//   {"type":"capture","id":"a1","slot":3,"amount":40}   (amount optional)
//   {"type":"revoke","id":"a1","slot":4}
// Flags: --pool N --card id:N (repeatable) --aging-k K --preempt-window W
// (flags override the config line). Exit code 2 when violations occurred.

import { readFileSync } from 'node:fs';
import { parseArgs, runCli } from '../src/cli.js';

const { args, file } = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log('usage: preauth [events.jsonl] [--pool N] [--card id:N]... [--aging-k K] [--preempt-window W]');
  process.exit(0);
}
const input = file ? readFileSync(file, 'utf8') : readFileSync(0, 'utf8');
const { output, exitCode } = runCli(input, args);
process.stdout.write(JSON.stringify(output, null, 2) + '\n');
process.exitCode = exitCode;
