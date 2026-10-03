import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const CLI = path.resolve('bin/cnc.js');

export const DEMO_PROGRAM = `(demo program with branch and subroutine)
#1 = 0
N10 G1 X0 Y0 F100
M98 Psub
#1 = #1 + 1
IF[#1 LT 2] GOTO 10
G1 X9 Y9
M98 Psub
Osub
G1 X5 Y5
G1 X6 Y6
M99
N40 G1 X7 Y7
M30
`;

// Hand-enumerated execution trace of DEMO_PROGRAM (absolute positions after each move).
export const DEMO_TRACE = [
  [0, 0, 0], [5, 5, 0], [6, 6, 0],
  [0, 0, 0], [5, 5, 0], [6, 6, 0],
  [9, 9, 0], [5, 5, 0], [6, 6, 0],
  [7, 7, 0],
].map(([x, y, z]) => ({ type: 'move', g: 1, x, y, z }));

export function runCli(args) {
  // The sandbox swallows piped stdio of spawned node processes, so capture
  // output via temp files instead.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cnc-cli-'));
  const outFile = path.join(dir, 'out');
  const errFile = path.join(dir, 'err');
  const outFd = fs.openSync(outFile, 'w');
  const errFd = fs.openSync(errFile, 'w');
  const res = spawnSync('node', [CLI, ...args], { stdio: ['ignore', outFd, errFd] });
  fs.closeSync(outFd);
  fs.closeSync(errFd);
  return {
    code: res.status,
    stdout: fs.readFileSync(outFile, 'utf8'),
    stderr: fs.readFileSync(errFile, 'utf8'),
  };
}

export function readEvents(file) {
  const text = fs.readFileSync(file, 'utf8');
  return text.split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

export function summaryOf(stdout) {
  const line = stdout.split('\n').filter(Boolean).find((l) => l.includes('"summary"'));
  return JSON.parse(line).summary;
}
