#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { runSpec } from './src/cli-core.js';

const input = process.argv[2] ? readFileSync(process.argv[2], 'utf8') : readFileSync(0, 'utf8');
const results = runSpec(JSON.parse(input));
console.log(JSON.stringify(results, null, 2));
