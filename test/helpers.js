import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

export function makeDir() {
  return mkdtemp(path.join(tmpdir(), 'wipcount-'));
}
