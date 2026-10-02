import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { main, ExitSentinel } from '../src/cli.js';

// The sandbox forbids spawning child processes, so the CLI is driven
// in-process with process.stdout/stderr/exit intercepted.
export function runCli(args) {
  let stdout = '';
  let stderr = '';
  let status = 0;
  const origOut = process.stdout.write;
  const origErr = process.stderr.write;
  const origExit = process.exit;
  process.stdout.write = (s) => { stdout += s; return true; };
  process.stderr.write = (s) => { stderr += s; return true; };
  process.exit = (code) => { status = code ?? 0; throw new ExitSentinel(status); };
  try {
    main(args);
  } catch (e) {
    if (!(e instanceof ExitSentinel)) throw e;
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
    process.exit = origExit;
  }
  const tryParse = (s) => {
    try {
      return JSON.parse(s);
    } catch {
      return null;
    }
  };
  return { status, stdout, stderr, json: tryParse(stdout), err: tryParse(stderr) };
}

export function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'maint-sync-'));
}

export function emit(dir, site, actor, op, extra = []) {
  return runCli(['emit', '--dir', dir, '--site', site, '--actor', actor, op, ...extra]);
}
