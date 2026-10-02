import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const CLI = fileURLToPath(new URL('../cli.js', import.meta.url));

export function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'daybook-'));
}

export function runCli(dir, args, env = {}) {
  try {
    const stdout = execFileSync(process.execPath, [CLI, '--dir', dir, ...args], {
      env: { ...process.env, ...env },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, stdout, json: JSON.parse(stdout), stderr: '' };
  } catch (e) {
    return {
      code: e.status,
      stdout: e.stdout?.toString() ?? '',
      stderr: e.stderr?.toString() ?? '',
    };
  }
}

export function readState(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'snapshot.json'), 'utf8'));
}
