#!/usr/bin/env node
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Engine } from './engine.js';

// Executes a batch of commands described as JSON text and returns the JSON
// text to write to stdout plus the process exit code. Pure and testable.
export function runCli(raw) {
  let spec;
  try {
    spec = JSON.parse(raw);
  } catch (error) {
    return {
      stdout: `${JSON.stringify({ ok: false, error: { code: 'E_INPUT', message: `invalid JSON input: ${error.message}` } })}\n`,
      exitCode: 1,
    };
  }
  const commands = Array.isArray(spec) ? spec : (Array.isArray(spec?.commands) ? spec.commands : [spec]);
  let engine = new Engine();
  const execCommand = (cmd) => {
    if (!cmd || typeof cmd !== 'object' || typeof cmd.cmd !== 'string') {
      return { ok: false, error: { code: 'E_CMD', message: 'command requires a "cmd" field' } };
    }
    switch (cmd.cmd) {
      case 'transact':
        return engine.transact(cmd);
      case 'rollback':
        return engine.rollback(cmd.txId);
      case 'build':
        return engine.buildAll();
      case 'state':
        return engine.state();
      case 'reset':
        engine = new Engine();
        return { ok: true };
      default:
        return { ok: false, error: { code: 'E_CMD', message: `unknown command: ${cmd.cmd}` } };
    }
  };
  const results = commands.map(execCommand);
  return { stdout: `${JSON.stringify({ results })}\n`, exitCode: 0 };
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

const invokedAs = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (import.meta.url === invokedAs) {
  const raw = await readStdin();
  const { stdout, exitCode } = runCli(raw);
  process.stdout.write(stdout);
  process.exitCode = exitCode;
}
