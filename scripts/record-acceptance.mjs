// Runs the acceptance suite (node --test) and appends its real stdout,
// stderr and exit code to test-results.txt. Child output is redirected to
// temporary files so nothing is lost through pipes.
import { spawn } from 'node:child_process';
import { appendFileSync, mkdtempSync, openSync, readFileSync, rmSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const dir = mkdtempSync(join(tmpdir(), 'acceptance-'));
const outPath = join(dir, 'stdout.txt');
const errPath = join(dir, 'stderr.txt');
const outFd = openSync(outPath, 'w');
const errFd = openSync(errPath, 'w');

const child = spawn(process.execPath, ['--test'], { cwd: root, stdio: ['ignore', outFd, errFd] });
child.on('close', (code) => {
  closeSync(outFd);
  closeSync(errFd);
  const stdout = readFileSync(outPath, 'utf8');
  const stderr = readFileSync(errPath, 'utf8');
  rmSync(dir, { recursive: true, force: true });
  const block = [
    '== case: node --test ==',
    'command: node --test',
    `exit code: ${code}`,
    '--- stdout ---',
    stdout.replace(/\n$/, ''),
    '--- stderr ---',
    stderr.replace(/\n$/, ''),
    '',
  ].join('\n');
  appendFileSync(join(root, 'test-results.txt'), block + '\n');
  process.stdout.write(stdout);
  process.stderr.write(stderr);
  process.exitCode = code;
});
