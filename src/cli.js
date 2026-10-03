#!/usr/bin/env node
import { runSession } from './session.js';

const chunks = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('end', () => {
  let input;
  try {
    input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (e) {
    console.log(JSON.stringify({ results: [{ ok: false, error: { code: 'E_INPUT', message: `invalid JSON: ${e.message}` } }] }));
    return;
  }
  console.log(JSON.stringify(runSession(input), null, 2));
});
