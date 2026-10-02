#!/usr/bin/env node
'use strict';

// Evidence citation-chain CLI (offline, Node.js stdlib only).
//
// Usage:
//   node cli.js certify <script.ev> --key <hmac-key> [--out doc.json]
//   node cli.js verify  <script.ev> --key <hmac-key> [--revoke NAME]...
//   node cli.js verify-cert <doc.json> --key <hmac-key> [--revoke NAME]...
//
// Success prints a JSON verdict on stdout (exit 0).
// Failure prints error text on stderr (exit 1).

const fs = require('node:fs');
const { parse, elaborate } = require('./src/index');
const { buildDocument } = require('./src/cert');
const { Session } = require('./src/session');

class CliError extends Error {}

function fail(message) {
  throw new CliError(message);
}

function parseArgs(argv) {
  const positional = [];
  const options = { revoke: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--key') { options.key = argv[++i]; continue; }
    if (arg === '--out') { options.out = argv[++i]; continue; }
    if (arg === '--revoke') { options.revoke.push(argv[++i]); continue; }
    if (arg.startsWith('--')) fail(`unknown option ${arg}`);
    positional.push(arg);
  }
  return { positional, options };
}

// Programmatic entry: returns { code, stdout, stderr }.
// code 0 = success (JSON verdict on stdout), 1 = failure (error text on stderr).
function run(argv) {
  try {
    return runUnsafe(argv);
  } catch (err) {
    return { code: 1, stdout: '', stderr: `error: ${err.message}\n` };
  }
}

function runUnsafe(argv) {
  const [command, ...rest] = argv;
  const { positional, options } = parseArgs(rest);
  if (!command || positional.length !== 1) {
    fail('usage: node cli.js <certify|verify|verify-cert> <file> --key <key> [--out f] [--revoke NAME]...');
  }
  if (typeof options.key !== 'string' || options.key.length === 0) {
    fail('missing required --key <hmac-key>');
  }
  const [file] = positional;

  let doc;
  if (command === 'verify-cert') {
    try {
      doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      fail(`cannot read certificate document: ${err.message}`);
    }
  } else if (command === 'certify' || command === 'verify') {
    let source;
    try {
      source = fs.readFileSync(file, 'utf8');
    } catch (err) {
      fail(`cannot read script: ${err.message}`);
    }
    let commits;
    try {
      commits = elaborate(parse(source));
    } catch (err) {
      fail(err.message);
    }
    doc = buildDocument(commits, options.key);
  } else {
    fail(`unknown command '${command}'`);
  }

  if (command === 'certify') {
    const json = `${JSON.stringify(doc, null, 2)}\n`;
    if (options.out) {
      fs.writeFileSync(options.out, json);
      return { code: 0, stdout: '', stderr: '' };
    }
    return { code: 0, stdout: json, stderr: '' };
  }

  const session = new Session(doc, options.key);
  for (const name of options.revoke) {
    session.revoke(name);
  }
  const verdict = session.verdict();
  const stdout = `${JSON.stringify(verdict, null, 2)}\n`;
  // Invalid verdict (e.g. revoked dependencies) exits 1 but still reports JSON.
  return { code: verdict.valid ? 0 : 1, stdout, stderr: '' };
}

function main() {
  const result = run(process.argv.slice(2));
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exit(result.code);
}

if (require.main === module) main();

module.exports = { run };
