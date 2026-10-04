import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Repo } from '../src/store.js';

export function tmpRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mvlin-'));
  return { dir, repo: new Repo(dir) };
}

export const batch = (id, pid, clock, ops, extra = {}) => ({ id, pid, clock, ops, ...extra });
export const assertOp = (key, value) => ({ op: 'assert', key, value });
export const retractOp = (key) => ({ op: 'retract', key });
