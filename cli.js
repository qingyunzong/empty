#!/usr/bin/env node
// Usage: node cli.js exec ops.jsonl --budget day=1000
import { runCli } from './src/cli.js';

const { code, stdout, stderr } = runCli(process.argv.slice(2));
for (const line of stdout) console.log(line);
for (const line of stderr) console.error(line);
process.exit(code);
