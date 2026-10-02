#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const { loadPolicy, GateError } = require('./policy');
const { readJsonl } = require('./jsonl');
const { loadRedactions, revokedFields } = require('./redactions');
const { computeView, computeSharedView } = require('./views');
const { writeView, verifyViewsDir } = require('./viewstore');
const { auditView, counterexample } = require('./audit');

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        args[key] = true;
      } else {
        args[key] = next;
        i++;
      }
    } else {
      args._.push(arg);
    }
  }
  return args;
}

function cmdGenerate(args) {
  if (!args.policy || !args.reports) {
    throw new GateError('generate requires --policy and --reports', 2);
  }
  const policy = loadPolicy(args.policy);
  const redactions = args.redactions ? loadRedactions(args.redactions) : [];
  const revoked = revokedFields(policy, redactions);
  const reports = readJsonl(args.reports);
  const outDir = args.out || 'views';
  const auditPath = args.audit || 'leak-audit.jsonl';
  const viewCfg = policy.views || {};
  const principals = viewCfg.principals || Object.keys(policy.roles || {});
  const sharedMembers = (viewCfg.shared && viewCfg.shared.members) || ['supplier', 'hq'];
  const leakChecks = viewCfg.leakChecks || [{ principal: 'supplier', label: 'recipe' }];

  const auditLines = [];
  const written = [];
  for (const report of reports) {
    const results = {};
    for (const principal of principals) {
      results[principal] = computeView(policy, report, principal, revoked);
    }
    const [memberA, memberB] = sharedMembers;
    if (results[memberA] && results[memberB]) {
      results.shared = computeSharedView(policy, report, results[memberA], results[memberB], memberA, memberB);
    }
    for (const result of Object.values(results)) {
      written.push(writeView(outDir, result));
      auditLines.push(JSON.stringify(auditView(policy, result)));
    }
    for (const check of leakChecks) {
      if (results[check.principal]) {
        auditLines.push(
          JSON.stringify(counterexample(policy, report, check.principal, results[check.principal], check.label, revoked))
        );
      }
    }
  }
  fs.writeFileSync(auditPath, auditLines.join('\n') + (auditLines.length ? '\n' : ''));
  console.log(`generated ${written.length} views for ${reports.length} report(s) -> ${outDir}`);
  console.log(`audit -> ${auditPath}`);
  return { written, auditPath };
}

function cmdVerify(args) {
  const dir = args.views || 'views';
  const results = verifyViewsDir(dir);
  let failed = 0;
  for (const r of results) {
    if (r.ok) {
      console.log(`ok ${r.file} ${r.status} ${String(r.actual).slice(0, 12)}`);
    } else {
      failed++;
      console.error(`MISMATCH ${r.file} expected=${r.expected.slice(0, 12)} actual=${String(r.actual).slice(0, 12)}`);
    }
  }
  if (failed > 0) {
    process.exitCode = 1;
  }
  return results;
}

function usage() {
  console.error('usage:');
  console.error('  node src/cli.js generate --policy field-policy.json --reports reports.jsonl [--redactions redactions.jsonl] [--out views] [--audit leak-audit.jsonl]');
  console.error('  node src/cli.js verify [--views views]');
}

function main(argv) {
  const args = parseArgs(argv);
  const command = args._[0];
  try {
    if (command === 'generate') return cmdGenerate(args);
    if (command === 'verify') return cmdVerify(args);
    usage();
    process.exitCode = 2;
    return null;
  } catch (err) {
    if (err instanceof GateError) {
      console.error(`error: ${err.message}`);
      process.exitCode = err.exitCode;
      return null;
    }
    throw err;
  }
}

if (require.main === module) {
  main(process.argv.slice(2));
}

module.exports = { parseArgs, cmdGenerate, cmdVerify, main };
