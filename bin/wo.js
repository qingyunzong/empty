#!/usr/bin/env node
import fs from 'node:fs';
import { runCli } from '../src/cli.js';

const needsStdin = ['add', 'del', 'query'].includes(process.argv[2]);
const stdin = needsStdin ? fs.readFileSync(0, 'utf8') : '';
const { code, lines } = runCli(process.argv.slice(2), stdin);
for (const line of lines) process.stdout.write(JSON.stringify(line) + '\n');
process.exitCode = code;
