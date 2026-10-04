#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { runRequest } from './graph.js';

export function runCli(inputText) {
  let response;
  try {
    const request = JSON.parse(inputText);
    response = runRequest(request);
  } catch (err) {
    response = { error: { code: 'E_INPUT', message: String(err.message ?? err) } };
  }
  return JSON.stringify(response, null, 2) + '\n';
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const chunks = [];
  process.stdin.on('data', (chunk) => chunks.push(chunk));
  process.stdin.on('end', () => {
    const input = Buffer.concat(chunks).toString('utf8');
    process.stdout.write(runCli(input));
  });
}
