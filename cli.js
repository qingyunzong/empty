#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const { createBank, BiobankError, ERR } = require('./src/biobank');
const { makeRecord, appendLog, loadLog } = require('./src/log');

function fail(code, message) {
  process.stderr.write(JSON.stringify({ error: { code, message } }) + '\n');
  process.exit(2);
}

function warn(code, message, extra) {
  process.stderr.write(JSON.stringify({ warning: { code, message, ...extra } }) + '\n');
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--config' || a === '--events' || a === '--log') {
      if (i + 1 >= argv.length) fail(ERR.INVALID_CONFIG, `missing value for ${a}`);
      args[a.slice(2)] = argv[++i];
    } else {
      fail(ERR.INVALID_CONFIG, `unknown argument: ${a}`);
    }
  }
  if (!args.config) fail(ERR.INVALID_CONFIG, '--config <path> is required');
  return args;
}

function groupSteps(events) {
  const steps = [];
  let current = [];
  for (const ev of events) {
    if (ev && ev.type === 'undo') {
      if (current.length) {
        steps.push(current);
        current = [];
      }
      steps.push([ev]);
    } else if (current.length && ev.time !== current[0].time) {
      steps.push(current);
      current = [ev];
    } else {
      current.push(ev);
    }
  }
  if (current.length) steps.push(current);
  return steps;
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  let config;
  try {
    config = JSON.parse(fs.readFileSync(args.config, 'utf8'));
  } catch (err) {
    fail(ERR.INVALID_CONFIG, `cannot read config: ${err.message}`);
  }

  let bank;
  try {
    bank = createBank(config);
  } catch (err) {
    if (err instanceof BiobankError) fail(err.code, err.message);
    throw err;
  }

  if (args.log) {
    const { records, corruptedLine } = loadLog(args.log);
    for (const rec of records) {
      try {
        bank.applyStep(rec.events);
      } catch (err) {
        if (err instanceof BiobankError) fail(err.code, `log replay failed at step ${rec.step}: ${err.message}`);
        throw err;
      }
    }
    if (corruptedLine !== null) {
      warn('LOG_CORRUPTED', `rejected half-written log record at line ${corruptedLine}; state recovered from valid prefix`, { line: corruptedLine });
    }
  }

  let text;
  try {
    text = args.events ? fs.readFileSync(args.events, 'utf8') : fs.readFileSync(0, 'utf8');
  } catch (err) {
    fail(ERR.INVALID_EVENT, `cannot read events: ${err.message}`);
  }

  const events = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === '') continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      fail(ERR.INVALID_EVENT, `line ${i + 1} is not valid JSON`);
    }
  }

  for (const stepEvents of groupSteps(events)) {
    let result;
    try {
      result = bank.applyStep(stepEvents);
    } catch (err) {
      if (err instanceof BiobankError) fail(err.code, err.message);
      throw err;
    }
    if (args.log) appendLog(args.log, makeRecord(result));
    process.stdout.write(JSON.stringify(result) + '\n');
  }
}

main();
