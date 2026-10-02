#!/usr/bin/env node
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { runFrames, exitCode } from './src/runner.js';

const TYPES = new Set(['payment', 'refund', 'approve', 'reject', 'expire', 'reverse']);

function validate(f) {
  if (!f || typeof f !== 'object' || Array.isArray(f)) return 'frame must be a JSON object';
  if (!TYPES.has(f.type)) return `unknown frame type: ${String(f.type)}`;
  if (!Number.isInteger(f.seq) || f.seq < 1) return 'seq must be a positive integer';
  if (f.ts !== undefined && (typeof f.ts !== 'number' || !(f.ts >= 0))) return 'ts must be a non-negative number';
  if (f.ack !== undefined && !Number.isInteger(f.ack)) return 'ack must be an integer';
  if (['refund', 'approve', 'reject', 'expire', 'reverse'].includes(f.type) && typeof f.key !== 'string') {
    return 'key (string) is required';
  }
  if (f.type === 'payment' || f.type === 'refund') {
    if (typeof f.amount !== 'number' || !(f.amount > 0)) return 'amount must be a positive number';
  }
  if ((f.type === 'payment' || f.type === 'refund') && typeof f.order !== 'string') return 'order (string) is required';
  if (f.type === 'refund' && typeof f.riskTag !== 'string') return 'riskTag (string) is required';
  return null;
}

export function runCli(opsPath, env = {}) {
  if (!opsPath) {
    return { code: 2, stdout: '', stderr: 'usage: node cli.js <ops.jsonl>\n' };
  }
  let text;
  try {
    text = fs.readFileSync(opsPath, 'utf8');
  } catch (err) {
    return { code: 2, stdout: '', stderr: `cannot read ${opsPath}: ${err.message}\n` };
  }
  const frames = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line) continue;
    let frame;
    try {
      frame = JSON.parse(line);
    } catch {
      return { code: 2, stdout: '', stderr: `frame error at line ${i + 1}: invalid JSON\n` };
    }
    const err = validate(frame);
    if (err) {
      return { code: 2, stdout: '', stderr: `frame error at line ${i + 1}: ${err}\n` };
    }
    frame.ts = frame.ts ?? 0;
    frames.push(frame);
  }
  const walPath = env.REFUND_WAL ?? `${opsPath}.wal`;
  const replay = env.REFUND_REPLAY === '1';
  const { report, responses } = runFrames(frames, { walPath, replay });
  return { code: exitCode(report), stdout: `${JSON.stringify({ ...report, responses }, null, 2)}\n`, stderr: '' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = runCli(process.argv[2], process.env);
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exitCode = result.code;
}
