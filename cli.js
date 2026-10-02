#!/usr/bin/env node
import { runCli } from './src/cli-core.js';

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

const stdinText = process.stdin.isTTY ? '' : await readStdin();
const { code, output } = await runCli(process.argv.slice(2), { stdinText });
process.stdout.write(output);
process.exitCode = code;
