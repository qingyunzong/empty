import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32 } from '../src/crc32.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'bin', 'cli.js');

export const HEADER_SIZE = 13;
export const MAX_PAYLOAD = 16 * 1024 * 1024;

export function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wal-test-'));
}

export function runCli(args, input) {
  // Note: spawnSync's `input` option is unreliable in some sandboxed
  // environments, so feed stdin through a real file descriptor instead.
  const inputFile = path.join(os.tmpdir(), `wal-cli-in-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(inputFile, input === undefined ? '' : JSON.stringify(input));
  const inputFd = fs.openSync(inputFile, 'r');
  const res = spawnSync(process.execPath, [CLI, ...args], {
    stdio: [inputFd, 'pipe', 'pipe'],
    encoding: 'utf8',
  });
  fs.closeSync(inputFd);
  fs.unlinkSync(inputFile);
  const lastLine = res.stdout.trim().split('\n').filter(Boolean).pop();
  return {
    code: res.status,
    json: lastLine ? JSON.parse(lastLine) : null,
    stdout: res.stdout,
    stderr: res.stderr,
  };
}

export function makeEvent(n, deviceId = 'dev-1') {
  const types = ['start', 'stop', 'alarm', 'count'];
  return { eventId: `evt-${n}`, deviceId, seq: n, type: types[n % types.length], value: n * 10 };
}

// Naive reference algorithm, written independently of src/wal.js:
// keep only the longest prefix of frames that are complete, CRC-valid
// and carry a set commit flag; everything after that is dropped.
export function referenceScan(buf) {
  const events = [];
  let pos = 0;
  while (pos + HEADER_SIZE <= buf.length) {
    const len = buf.readUInt32LE(pos);
    const crc = buf.readUInt32LE(pos + 4);
    const commit = buf.readUInt8(pos + 12);
    if (len === 0 || len > MAX_PAYLOAD) break;
    if (pos + HEADER_SIZE + len > buf.length) break;
    const payload = buf.subarray(pos + HEADER_SIZE, pos + HEADER_SIZE + len);
    if (crc32(payload) !== crc) break;
    if (commit !== 1) break;
    events.push(JSON.parse(payload.toString('utf8')));
    pos += HEADER_SIZE + len;
  }
  return { events, validBytes: pos };
}

export function walBytes(dir) {
  return fs.readFileSync(path.join(dir, 'wal.log'));
}
