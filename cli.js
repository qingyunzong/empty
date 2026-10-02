#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { deposit, executeFill, cancelFill, acknowledge, snapshot, SagaError } from './src/saga.js';
import { loadState, saveState } from './src/store.js';

function dispatch(state, command) {
  switch (command.cmd) {
    case 'deposit':
      return { ok: true, ledger: deposit(state, command.amount) };
    case 'fill':
      return { ok: true, fill: executeFill(state, command) };
    case 'cancel':
      return { ok: true, certificate: cancelFill(state, command.id, { failAt: command.failAt }) };
    case 'ack':
      return { ok: true, result: acknowledge(state, command.id, command.step) };
    case 'status':
      return { ok: true, snapshot: snapshot(state, command.id) };
    default:
      throw new SagaError('UNKNOWN_COMMAND', `unknown cmd: ${command.cmd}`);
  }
}

function main(argv) {
  const [commandJson, logDir] = argv;
  if (!commandJson || !logDir) {
    throw new SagaError('USAGE', 'usage: node cli.js <command-json> <log-dir>');
  }
  let command;
  try {
    command = JSON.parse(commandJson);
  } catch {
    throw new SagaError('INVALID_COMMAND', 'command is not valid JSON');
  }
  const state = loadState(logDir);
  try {
    return dispatch(state, command);
  } finally {
    saveState(logDir, state); // 失败时也要持久化,保证重试从未完成分支继续
  }
}

// 返回 { exitCode, output }; 错误时 exitCode=1 且 output.error.code 为错误代码
export function run(argv) {
  try {
    return { exitCode: 0, output: main(argv) };
  } catch (err) {
    return {
      exitCode: 1,
      output: {
        error: {
          code: err.code || 'INTERNAL_ERROR',
          message: err.message,
          ...(err.details ? { details: err.details } : {}),
        },
      },
    };
  }
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  const { exitCode, output } = run(process.argv.slice(2));
  process.stdout.write(JSON.stringify(output) + '\n');
  process.exit(exitCode);
}
