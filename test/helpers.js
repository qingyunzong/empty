import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export async function tmpdir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'alert-store-'));
}

export async function cleanup(dir) {
  await fs.rm(dir, { recursive: true, force: true });
}
