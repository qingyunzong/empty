#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const { Account, E_RANGE } = require('./lib/account');

class CliError extends Error {}

// Runs the CLI. Returns the process exit code (0 = all ops ok, 1 = failures).
// io defaults to process stdout/stderr but can be swapped for testing.
function run(argv, io = {}) {
  const stdout = io.stdout || ((s) => process.stdout.write(s));
  const stderr = io.stderr || ((s) => process.stderr.write(s));

  try {
    const [inputPath, outputPath] = argv;
    if (!inputPath || !outputPath) {
      throw new CliError('usage: node cli.js <ops.jsonl> <report.json>');
    }

    let raw;
    try {
      raw = fs.readFileSync(inputPath, 'utf8');
    } catch (err) {
      throw new CliError(`${E_RANGE}: cannot read ${inputPath}: ${err.message}`);
    }

    const lines = raw.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
    if (lines.length === 0) throw new CliError(`${E_RANGE}: ${inputPath} is empty`);

    const records = lines.map((line, i) => {
      try {
        return JSON.parse(line);
      } catch {
        throw new CliError(`${E_RANGE}: line ${i + 1}: invalid JSON`);
      }
    });

    const head = records[0];
    if (!head || (head.op !== 'config' && head.op !== 'init')) {
      throw new CliError(`${E_RANGE}: first line must be a config record, e.g. {"op":"config","totalLimit":1000,"categoryLimits":{"travel":300}}`);
    }

    let account;
    try {
      account = new Account({ totalLimit: head.totalLimit, categoryLimits: head.categoryLimits || {} });
    } catch (err) {
      throw new CliError(err.message);
    }

    const ops = records.slice(1);
    for (let i = 0; i < ops.length; i += 1) {
      const op = ops[i];
      if (!op || !Number.isSafeInteger(op.ts) || typeof op.id !== 'string' || op.id.length === 0 || typeof op.op !== 'string') {
        throw new CliError(`${E_RANGE}: line ${i + 2}: op requires integer ts, non-empty string id and string op`);
      }
    }

    const report = account.applyAll(ops);

    try {
      fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
    } catch (err) {
      throw new CliError(`${E_RANGE}: cannot write ${outputPath}: ${err.message}`);
    }

    const failed = report.steps.filter((s) => !s.ok);
    for (const s of failed) {
      const detail = s.detail ? ` ${s.detail}` : '';
      stderr(`${s.reason}: id=${s.id} op=${s.op} ts=${s.ts}${detail}\n`);
    }
    stdout(`steps=${report.steps.length} failed=${failed.length} available=${report.final.available}\n`);
    return failed.length > 0 ? 1 : 0;
  } catch (err) {
    if (err instanceof CliError) {
      stderr(`${err.message}\n`);
      return 1;
    }
    throw err;
  }
}

if (require.main === module) {
  process.exitCode = run(process.argv.slice(2));
}

module.exports = { run };
