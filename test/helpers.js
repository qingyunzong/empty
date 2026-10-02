import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {mkdtempSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

export const BIN = fileURLToPath(new URL('../bin/calplan.js', import.meta.url));

export function cli(args) {
  return spawnSync(process.execPath, [BIN, ...args], {encoding: 'utf8'});
}

export function ok(args) {
  const r = cli(args);
  if (r.status !== 0) {
    throw new Error(`cli failed (${r.status}): ${r.stderr}`);
  }
  return JSON.parse(r.stdout);
}

export function tempStateDir() {
  return mkdtempSync(join(tmpdir(), 'calplan-'));
}

export function writeJson(dir, name, obj) {
  const p = join(dir, name);
  writeFileSync(p, JSON.stringify(obj, null, 2));
  return p;
}
