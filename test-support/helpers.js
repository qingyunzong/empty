import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const BIN = fileURLToPath(new URL('../bin/pack.js', import.meta.url));
export const HASH64 = 'a'.repeat(64);

export function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pack-test-'));
}

export function writeInput(events) {
  const inDir = tmpdir();
  fs.writeFileSync(
    path.join(inDir, 'events.jsonl'),
    events.map((e) => JSON.stringify(e)).join('\n') + '\n',
  );
  return inDir;
}

export function runCli(inDir, outDir, env = {}) {
  // This sandbox denies pipe-based stdio (EPERM); redirect to files instead.
  fs.mkdirSync(outDir, { recursive: true });
  const stdoutPath = path.join(outDir, '.stdout.log');
  const stderrPath = path.join(outDir, '.stderr.log');
  const outFd = fs.openSync(stdoutPath, 'w');
  const errFd = fs.openSync(stderrPath, 'w');
  try {
    const proc = spawnSync(process.execPath, [BIN, 'quarantine', '--in', inDir, '--out', outDir], {
      env: { ...process.env, ...env },
      stdio: ['ignore', outFd, errFd],
    });
    return {
      status: proc.status,
      error: proc.error,
      get stdout() { return fs.readFileSync(stdoutPath, 'utf8'); },
      get stderr() { return fs.readFileSync(stderrPath, 'utf8'); },
    };
  } finally {
    fs.closeSync(outFd);
    fs.closeSync(errFd);
  }
}

export function readOut(outDir) {
  const files = ['cases.jsonl', 'release.json', 'wal.jsonl', 'late.log'];
  const result = {};
  for (const f of files) {
    const p = path.join(outDir, f);
    result[f] = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
  }
  return result;
}

export const vision = (eventTs, frame, sku, defect, hash = HASH64) => ({
  type: 'vision', eventTs, frame, sku, defect, hash, op: 'add',
});
export const barcode = (eventTs, frame, caseId) => ({
  type: 'barcode', eventTs, frame, case: caseId, op: 'add',
});
export const audit = (eventTs, sku, pass) => ({
  type: 'audit', eventTs, sku, pass, op: 'add',
});
export const retract = (eventTs, kind, id) => ({
  type: 'retract', eventTs, kind, id,
});
