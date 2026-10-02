import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { hashEvent } from '../src/canonical.js';
import { serializeLog } from '../src/log.js';

export const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'audit.js');

export function makeLog(n) {
  const events = [];
  let prev = '';
  for (let i = 1; i <= n; i++) {
    const body = { id: `evt-${i}`, amount: i * 100, currency: 'CNY' };
    const hash = hashEvent(prev, body);
    events.push({ seq: i, prevHash: prev, hash, body });
    prev = hash;
  }
  return events;
}

export function makeDir() {
  return mkdtempSync(join(tmpdir(), 'audit-test-'));
}

export function writeJsonl(path, events) {
  writeFileSync(path, serializeLog(events));
}

function shQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

// NOTE: this sandbox drops grandchild node stdout on pipes, so capture via files.
export function runCli(args) {
  const dir = mkdtempSync(join(tmpdir(), 'audit-cli-'));
  const outF = join(dir, 'out');
  const errF = join(dir, 'err');
  const codeF = join(dir, 'code');
  const cmd = [process.execPath, BIN, ...args].map(shQuote).join(' ');
  spawnSync('bash', ['-c', `${cmd} >${shQuote(outF)} 2>${shQuote(errF)}; echo -n $? >${shQuote(codeF)}`]);
  return {
    code: Number(readFileSync(codeF, 'utf8')),
    stdout: readFileSync(outF, 'utf8').trim(),
    stderr: readFileSync(errF, 'utf8').trim(),
  };
}
