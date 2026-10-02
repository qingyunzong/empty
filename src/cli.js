#!/usr/bin/env node
'use strict';

const fs = require('fs');
const { loadPolicies, InputError, UnknownRefError } = require('./model');
const { evaluateRequest } = require('./evaluate');

function fatal(code, message) {
  fs.writeSync(2, `error: ${message}\n`);
  process.exit(code);
}

function usage() {
  process.stdout.write(
    [
      'usage: node src/cli.js [--policies policies.json] [--requests requests.jsonl]',
      '                        [--decisions decisions.jsonl] [--audit audit.log]',
      '',
      'exit codes: 0 ok | 1 io/usage | 2 invalid JSON or invalid input | 3 unknown subject/device | 4 inheritance cycle',
    ].join('\n') + '\n'
  );
  process.exit(0);
}

function parseArgs(argv) {
  const args = {
    policies: 'policies.json',
    requests: 'requests.jsonl',
    decisions: 'decisions.jsonl',
    audit: 'audit.log',
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--policies' || a === '--requests' || a === '--decisions' || a === '--audit') {
      const key = a.slice(2);
      if (i + 1 >= argv.length) fatal(1, `missing value for ${a}`);
      args[key] = argv[++i];
    } else if (a === '--help' || a === '-h') {
      usage();
    } else {
      fatal(1, `unknown argument: ${a}`);
    }
  }
  return args;
}

function readFile(path, what) {
  try {
    return fs.readFileSync(path, 'utf8');
  } catch (e) {
    fatal(1, `cannot read ${what} file ${path}: ${e.message}`);
  }
}

function validateRequest(req, where) {
  if (req === null || typeof req !== 'object' || Array.isArray(req)) {
    throw new InputError(`${where}: request must be an object`);
  }
  if (typeof req.id !== 'string' && typeof req.id !== 'number') {
    throw new InputError(`${where}: missing request id`);
  }
  for (const f of ['subject', 'device', 'action']) {
    if (typeof req[f] !== 'string') throw new InputError(`${where}: '${f}' must be a string`);
  }
  if (typeof req.time !== 'string' || Number.isNaN(Date.parse(req.time))) {
    throw new InputError(`${where}: invalid time '${req.time}'`);
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  let rawPolicies;
  try {
    rawPolicies = JSON.parse(readFile(args.policies, 'policies'));
  } catch (e) {
    fatal(2, `invalid JSON in ${args.policies}: ${e.message}`);
  }

  let policies;
  try {
    policies = loadPolicies(rawPolicies);
  } catch (e) {
    fatal(e.exitCode || 2, e.message);
  }

  const requests = [];
  const lines = readFile(args.requests, 'requests').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    let req;
    try {
      req = JSON.parse(line);
    } catch (e) {
      fatal(2, `invalid JSON in ${args.requests} line ${i + 1}: ${e.message}`);
    }
    try {
      validateRequest(req, `${args.requests} line ${i + 1}`);
    } catch (e) {
      fatal(e.exitCode || 2, e.message);
    }
    requests.push(req);
  }

  const unknowns = [];
  for (const req of requests) {
    if (!policies.subjects[req.subject]) {
      unknowns.push({ kind: 'subject', name: req.subject, requestId: req.id });
    }
    if (!policies.devices[req.device]) {
      unknowns.push({ kind: 'device', name: req.device, requestId: req.id });
    }
  }
  if (unknowns.length) {
    fatal(3, new UnknownRefError(unknowns).message);
  }

  const audit = [];
  const decisions = requests.map((r) => evaluateRequest(policies, r, { audit }));

  fs.writeFileSync(
    args.decisions,
    decisions.map((d) => JSON.stringify(d)).join('\n') + (decisions.length ? '\n' : '')
  );
  fs.writeFileSync(args.audit, audit.join('\n') + (audit.length ? '\n' : ''));

  const allows = decisions.filter((d) => d.decision === 'allow').length;
  const conflicts = decisions.filter((d) => d.conflict).length;
  process.stdout.write(
    `evaluated ${decisions.length} request(s): ${allows} allow, ${decisions.length - allows} deny, ${conflicts} conflict(s)\n`
  );
}

if (require.main === module) {
  try {
    main();
  } catch (e) {
    fatal(1, e && e.message ? e.message : String(e));
  }
}

module.exports = { main };
