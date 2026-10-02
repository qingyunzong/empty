#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { writeFileSync, writeSync } from 'node:fs';
import { appendToLog, readJsonl, writeJsonl } from '../lib/store.js';
import { verify, loadRecords, checkChains, causalOrder, VerifyError } from '../lib/verify.js';
import { canonical } from '../lib/canon.js';

const USAGE = `ebr-chain — offline aseptic-filling batch record aggregation

usage:
  cli.js append --log FILE --site S --epoch N --type T [--payload JSON] [--target HASH] [--scope S]
  cli.js merge  --out FILE IN.jsonl...
  cli.js verify IN.jsonl...
  cli.js export --out CERT.json IN.jsonl...

exit codes: 0 ok (missing data => status "unknown", still 0)
            15 broken hash chain
            16 low-epoch backfill after site exit
            2  usage / IO error
`;

function out(text) { writeSync(1, text); }
function errOut(text) { writeSync(2, text); }

function die(msg, code = 2) {
  errOut(`error: ${msg}\n`);
  process.exit(code);
}

function parseJson(text, what) {
  try {
    return JSON.parse(text);
  } catch {
    die(`invalid JSON for ${what}`);
  }
}

function cmdAppend(args) {
  const { values } = parseArgs({
    args,
    options: {
      log: { type: 'string' },
      site: { type: 'string' },
      epoch: { type: 'string' },
      type: { type: 'string' },
      payload: { type: 'string' },
      target: { type: 'string' },
      scope: { type: 'string' },
    },
    strict: true,
  });
  for (const k of ['log', 'site', 'epoch', 'type']) {
    if (!values[k]) die(`append requires --${k}`);
  }
  const epoch = Number(values.epoch);
  if (!Number.isInteger(epoch) || epoch < 0) die('--epoch must be a non-negative integer');
  const payload = values.payload !== undefined ? parseJson(values.payload, '--payload') : null;
  try {
    const rec = appendToLog(values.log, {
      site: values.site,
      epoch,
      type: values.type,
      payload,
      target: values.target ?? null,
      scope: values.scope ?? null,
    });
    out(canonical(rec) + '\n');
  } catch (err) {
    die(err.message);
  }
}

function loadInputs(files) {
  if (files.length === 0) die('no input files given');
  const records = [];
  for (const f of files) {
    try {
      records.push(...readJsonl(f));
    } catch (err) {
      die(err.message);
    }
  }
  return records;
}

function cmdMerge(args) {
  const { values, positionals } = parseArgs({
    args,
    options: { out: { type: 'string' } },
    allowPositionals: true,
    strict: true,
  });
  if (!values.out) die('merge requires --out');
  const records = loadInputs(positionals);
  const byHash = loadRecords(records);
  checkChains(byHash); // validates links/epochs; gaps tolerated
  const ordered = causalOrder(byHash);
  writeJsonl(values.out, ordered);
  out(canonical({ merged: ordered.length, out: values.out }) + '\n');
}

function buildCertificate(files) {
  const records = loadInputs(files);
  return verify(records);
}

function cmdVerify(args) {
  const { positionals } = parseArgs({ args, options: {}, allowPositionals: true, strict: true });
  const cert = buildCertificate(positionals);
  out(canonical(cert) + '\n');
}

function cmdExport(args) {
  const { values, positionals } = parseArgs({
    args,
    options: { out: { type: 'string' } },
    allowPositionals: true,
    strict: true,
  });
  if (!values.out) die('export requires --out');
  const cert = buildCertificate(positionals);
  writeFileSync(values.out, JSON.stringify(cert, null, 2) + '\n');
  out(canonical({ exported: values.out, status: cert.status, head: cert.head }) + '\n');
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  try {
    switch (cmd) {
      case 'append': return cmdAppend(rest);
      case 'merge': return cmdMerge(rest);
      case 'verify': return cmdVerify(rest);
      case 'export': return cmdExport(rest);
      case undefined:
      case '--help':
      case '-h':
        out(USAGE);
        return;
      default:
        die(`unknown command: ${cmd}`);
    }
  } catch (err) {
    if (err instanceof VerifyError) {
      errOut(`error: ${err.message}\n`);
      process.exit(err.exitCode);
    }
    if (err && err.code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION') die(err.message);
    throw err;
  }
}

main();
