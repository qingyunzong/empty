#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { buildCertificate } from '../src/certificate.js';
import { InvalidReconError } from '../src/reconcile.js';

function usage() {
  console.error('usage: recon minimize <recon.json>');
  process.exit(2);
}

const [command, file] = process.argv.slice(2);
if (command !== 'minimize' || !file) {
  usage();
}

let input;
try {
  input = JSON.parse(readFileSync(file, 'utf8'));
} catch (err) {
  console.error(`INVALID_RECON: cannot read or parse '${file}': ${err.message}`);
  process.exit(1);
}

try {
  const certificate = buildCertificate(input);
  process.stdout.write(JSON.stringify(certificate, null, 2) + '\n');
} catch (err) {
  if (err instanceof InvalidReconError) {
    console.error(`INVALID_RECON: ${err.message}`);
    process.exit(1);
  }
  throw err;
}
