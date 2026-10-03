import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import { Ledger } from '../src/ledger.js';

export function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'settle-test-'));
}

export function openLedger(dir) {
  return new Ledger(new Store(dir));
}

// root(1000)
//   alpha(400)
//     alpha-1(150)
//     alpha-2(100)
//   beta(300)
export function buildTree(dir) {
  const ledger = openLedger(dir);
  ledger.initRoot('root', 1000);
  ledger.addGroup('root', 'alpha', 400);
  ledger.addGroup('alpha', 'alpha-1', 150);
  ledger.addGroup('alpha', 'alpha-2', 100);
  ledger.addGroup('root', 'beta', 300);
  return ledger;
}
