'use strict';

const fs = require('node:fs');
const { checkLog } = require('./src/check');
const { compareFlows } = require('./src/equiv');
const { FlowError } = require('./src/errors');

function parseLog(text) {
  const events = [];
  text.split(/\r?\n/).forEach((line, idx) => {
    const trimmed = line.trim();
    if (trimmed === '') return;
    let value;
    try {
      value = JSON.parse(trimmed);
    } catch {
      throw new FlowError('PARSE_ERROR', `log line ${idx + 1} is not valid JSON`);
    }
    if (typeof value === 'string') events.push(value);
    else if (value && typeof value === 'object') {
      const name = value.event ?? value.type ?? value.name;
      events.push(typeof name === 'string' ? name : null);
    } else {
      events.push(null);
    }
  });
  return events;
}

function emit(payload, exitCode) {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  process.exitCode = exitCode;
}

function runCli(argv, readFile = (p) => fs.readFileSync(p, 'utf8')) {
  try {
    return dispatch(argv, readFile);
  } catch (err) {
    if (err instanceof FlowError) {
      return { exitCode: 2, payload: { error: err.code, message: err.message } };
    }
    throw err;
  }
}

function dispatch(argv, readFile) {
  const [cmd, ...args] = argv;
  if (cmd === 'check') {
    const [flowPath, logPath, ...rest] = args;
    if (!flowPath || !logPath) {
      return { exitCode: 2, payload: { error: 'USAGE', message: 'node cli.js check <flow.re> <log.jsonl> [--k N]' } };
    }
    let K;
    const kIdx = rest.indexOf('--k');
    if (kIdx >= 0) K = Number(rest[kIdx + 1]);
    const source = readFile(flowPath);
    const events = parseLog(readFile(logPath));
    const result = checkLog(source, events, K === undefined ? {} : { K });
    return { exitCode: result.accept ? 0 : 1, payload: result };
  } else if (cmd === 'equiv') {
    const [leftPath, rightPath] = args;
    if (!leftPath || !rightPath) {
      return { exitCode: 2, payload: { error: 'USAGE', message: 'node cli.js equiv <left.re> <right.re>' } };
    }
    const result = compareFlows(readFile(leftPath), readFile(rightPath));
    return { exitCode: result.equiv ? 0 : 1, payload: result };
  } else {
    return { exitCode: 2, payload: { error: 'USAGE', message: 'node cli.js <check|equiv> ...' } };
  }
}

function main() {
  let outcome;
  try {
    outcome = runCli(process.argv.slice(2));
  } catch (err) {
    outcome = { exitCode: 2, payload: { error: 'INTERNAL', message: String(err && err.message ? err.message : err) } };
  }
  process.stdout.write(`${JSON.stringify(outcome.payload, null, 2)}\n`);
  process.exitCode = outcome.exitCode;
}

if (require.main === module) main();

module.exports = { runCli };
