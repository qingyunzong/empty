import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'ledger.js');

export function makeDir(prefix = 'ledger-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function runCli(args, { dir, env = {} } = {}) {
  // NOTE: this environment drops piped stdio of node grandchildren, so the
  // child's stdout/stderr are captured through temp files instead of pipes.
  const tag = `cli-${process.pid}-${Math.random().toString(36).slice(2)}`;
  const outFile = path.join(os.tmpdir(), tag);
  const errFile = `${outFile}.err`;
  const outFd = fs.openSync(outFile, 'w');
  const errFd = fs.openSync(errFile, 'w');
  const res = spawnSync(process.execPath, [BIN, '--dir', dir, ...args], {
    env: { ...process.env, ...env },
    stdio: ['ignore', outFd, errFd],
  });
  fs.closeSync(outFd);
  fs.closeSync(errFd);
  const stdout = fs.readFileSync(outFile, 'utf8');
  const stderr = fs.readFileSync(errFile, 'utf8');
  fs.rmSync(outFile, { force: true });
  fs.rmSync(errFile, { force: true });
  const out = stdout.trim();
  const err = stderr.trim();
  return {
    status: res.status,
    stdout: out,
    stderr: err,
    json: out ? JSON.parse(out) : null,
    errJson: err ? JSON.parse(err) : null,
  };
}

export function initLedger(dir) {
  return runCli(['init'], { dir });
}

export function appendTx(dir, tx) {
  const file = path.join(dir, `input-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(file, JSON.stringify(tx));
  return runCli(['append', file], { dir });
}

export function readChain(dir) {
  const head = fs.readFileSync(path.join(dir, 'HEAD'), 'utf8').trim();
  const chain = [];
  let cursor = head === 'EMPTY' || head === '' ? null : head;
  while (cursor) {
    const tx = JSON.parse(fs.readFileSync(path.join(dir, 'txs', `${cursor}.json`), 'utf8'));
    chain.push({ hash: cursor, tx });
    cursor = tx.parent;
  }
  return chain.reverse();
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
