#!/usr/bin/env node
'use strict';
// 用法: node cli.js <events.jsonl> [--now N] [--deadline N]
// 退出码: 0 成功; 2 输入非法; 4 守恒破坏。
const fs = require('node:fs');
const {
  Store,
  parseJsonl,
  ValidationError,
  ConservationError,
  DEFAULT_DEADLINE,
} = require('./lib');

const USAGE = 'usage: node cli.js <events.jsonl> [--now N] [--deadline N]';

function fail(code, message) {
  fs.writeSync(2, `${message}\n`);
  process.exit(code);
}

function parseArgs(argv) {
  let file = null;
  let now = 0;
  let deadline = DEFAULT_DEADLINE;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    let name = null;
    let value = null;
    if (arg === '--now' || arg === '--deadline') {
      name = arg.slice(2);
      value = argv[++i];
    } else if (arg.startsWith('--now=')) {
      name = 'now';
      value = arg.slice('--now='.length);
    } else if (arg.startsWith('--deadline=')) {
      name = 'deadline';
      value = arg.slice('--deadline='.length);
    } else if (arg.startsWith('-')) {
      fail(2, `unknown option: ${arg}\n${USAGE}`);
    } else if (file === null) {
      file = arg;
      continue;
    } else {
      fail(2, `unexpected argument: ${arg}\n${USAGE}`);
    }
    if (value === undefined) fail(2, `missing value for --${name}\n${USAGE}`);
    const num = Number(value);
    if (!Number.isInteger(num) || num < (name === 'deadline' ? 1 : 0)) {
      fail(2, `--${name} must be an integer >= ${name === 'deadline' ? 1 : 0}, got: ${value}`);
    }
    if (name === 'now') now = num;
    else deadline = num;
  }
  if (file === null) fail(2, USAGE);
  return { file, now, deadline };
}

function main() {
  const { file, now, deadline } = parseArgs(process.argv.slice(2));
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    fail(2, `cannot read ${file}: ${err.message}`);
  }
  let events;
  try {
    events = parseJsonl(text);
  } catch (err) {
    if (err instanceof ValidationError) {
      const where = err.line !== undefined ? ` at line ${err.line}` : '';
      fail(2, `invalid input${where}: ${err.message}`);
    }
    throw err;
  }
  const store = new Store({ now, deadline });
  for (const event of events) store.ingest(event);
  let report;
  try {
    report = store.finalize();
  } catch (err) {
    if (err instanceof ConservationError) {
      fail(4, `conservation violation: ${err.message}`);
    }
    throw err;
  }
  fs.writeSync(1, `${JSON.stringify(report, null, 2)}\n`);
}

main();
