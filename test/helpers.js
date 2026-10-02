import { fileURLToPath } from 'node:url';
import { main } from '../src/cli.js';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));

// Runs the CLI in-process: the sandbox forbids nested spawnSync, and calling
// main() directly exercises the same code path as bin/agv.js.
export function cli(args, input = '') {
  const lines = [];
  const errs = [];
  const code = main(args, {
    stdout: (s) => lines.push(s),
    stderr: (s) => errs.push(s),
    stdin: () => input,
  });
  return { code, stdout: lines.join('\n'), stderr: errs.join('\n'), lines };
}

export function jsonl(text) {
  return text
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

export const join = (agv, time = 0) => ({ type: 'join', agv, time });

export const claim = (task, agv, epoch, time, leaseMs, vc) => ({
  type: 'claim', task, agv, epoch, time, leaseMs, vc,
});
