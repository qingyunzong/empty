#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const { STAGES, Store, WorkflowError, runPayment, runCancel } = require('./workflow');

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--state') opts.state = argv[++i];
    else if (arg === '--cmd') opts.cmd = argv[++i];
    else if (arg === '--cmd-file') opts.cmdFile = argv[++i];
    else if (arg === '--crash-point') opts.crashPoint = argv[++i];
    else throw new WorkflowError('INVALID_ARGS', `unknown argument: ${arg}`);
  }
  return opts;
}

function readCommand(opts) {
  let raw;
  if (opts.cmd !== undefined) raw = opts.cmd;
  else if (opts.cmdFile !== undefined) raw = fs.readFileSync(opts.cmdFile, 'utf8');
  else throw new WorkflowError('INVALID_ARGS', 'missing --cmd or --cmd-file');

  let cmd;
  try {
    cmd = JSON.parse(raw);
  } catch {
    throw new WorkflowError('INVALID_COMMAND', 'command is not valid JSON');
  }
  validateCommand(cmd);
  return cmd;
}

function validateCommand(cmd) {
  const bad = (msg) => new WorkflowError('INVALID_COMMAND', msg);
  if (!cmd || typeof cmd !== 'object' || Array.isArray(cmd)) throw bad('command must be an object');
  if (typeof cmd.commandId !== 'string' || cmd.commandId.length === 0) throw bad('commandId is required');
  if (typeof cmd.paymentId !== 'string' || cmd.paymentId.length === 0) throw bad('paymentId is required');
  if (cmd.type === 'PAY') {
    if (typeof cmd.amount !== 'number' || !Number.isFinite(cmd.amount) || cmd.amount <= 0) {
      throw bad('amount must be a positive number');
    }
  } else if (cmd.type !== 'CANCEL') {
    throw bad(`unknown command type: ${String(cmd.type)}`);
  }
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.state) throw new WorkflowError('INVALID_ARGS', 'missing --state <dir>');
  if (opts.crashPoint !== undefined && !STAGES.includes(opts.crashPoint)) {
    throw new WorkflowError('INVALID_ARGS', `crash point must be one of ${STAGES.join(', ')}`);
  }

  const cmd = readCommand(opts);
  const store = new Store(opts.state);

  let result;
  if (cmd.type === 'PAY') result = runPayment(store, cmd, opts.crashPoint);
  else result = runCancel(store, cmd);

  if (result && result.crashed) {
    // Simulated crash: the stage event is durably persisted, the derived
    // state is not. Die like a real crash so restart must recover.
    process.kill(process.pid, 'SIGKILL');
    return;
  }
  process.stdout.write(JSON.stringify(result) + '\n');
}

try {
  main();
} catch (err) {
  const code = err instanceof WorkflowError ? err.code : 'INTERNAL_ERROR';
  process.stdout.write(JSON.stringify({ ok: false, error: { code, message: err.message } }) + '\n');
  process.exit(1);
}
