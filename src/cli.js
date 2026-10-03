#!/usr/bin/env node
import { runRequest } from './session.js';

// Reads one JSON request from stdin:
//   { "tasks": [...], "transactions": [{ "maxRecompute": N, "ops": [...] }] }
// A bare { "ops": [...] } body is treated as a single transaction.
// Writes one JSON response to stdout: { "ok": true, "results": [...] }.
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const response = runRequest(Buffer.concat(chunks).toString('utf8'));
process.stdout.write(JSON.stringify(response, null, 2) + '\n');
