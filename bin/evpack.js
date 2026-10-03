#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const { Store } = require('../src/state');
const engine = require('../src/engine');
const { RULES_VERSION } = require('../src/util');

const EXIT_USAGE = 2;

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        args[key] = true;
      } else {
        args[key] = next;
        i++;
      }
    } else {
      args._.push(a);
    }
  }
  return args;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function loadConfig(args) {
  if (!args.config) {
    return { workers: [{ id: 'w-default', throughput: 1 << 30, maxClassification: 1 << 30 }], waitThreshold: 0 };
  }
  const cfg = readJson(args.config);
  return {
    workers: cfg.workers,
    waitThreshold: cfg.waitThreshold || 0,
    quotas: cfg.quotas || {},
    rulesVersion: cfg.rulesVersion || RULES_VERSION,
  };
}

function emit(obj) {
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
}

function fail(err) {
  process.exitCode = err && err.exitCode ? err.exitCode : 1;
  emit({ ok: false, error: { code: err.code || 'internal-error', message: err.message } });
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];
  if (!command || !['submit', 'verify', 'correct', 'recall', 'audit'].includes(command)) {
    process.stderr.write('usage: evpack <submit|verify|correct|recall|audit> --state DIR [--events FILE] [--config FILE]\n');
    process.exitCode = EXIT_USAGE;
    return;
  }
  if (!args.state) {
    process.stderr.write('error: --state DIR is required\n');
    process.exitCode = EXIT_USAGE;
    return;
  }
  try {
    const store = new Store(args.state);
    if (command === 'audit') {
      emit(engine.audit(store, loadConfig(args)));
      return;
    }
    if (!args.events) {
      process.stderr.write('error: --events FILE is required\n');
      process.exitCode = EXIT_USAGE;
      return;
    }
    const payload = readJson(args.events);
    const events = Array.isArray(payload) ? payload : [payload];
    const config = loadConfig(args);
    const result = engine.execute(store, config, command, events);
    emit(result);
  } catch (err) {
    fail(err);
  }
}

main();
