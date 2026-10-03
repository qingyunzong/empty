import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main } from '../cli.js';

export function makeWorld({ recipes, approvals, attempts }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rg-'));
  fs.writeFileSync(path.join(dir, 'recipes.json'), JSON.stringify(recipes, null, 2));
  fs.writeFileSync(
    path.join(dir, 'approvals.jsonl'),
    approvals.map((a) => JSON.stringify(a)).join('\n') + '\n',
  );
  fs.writeFileSync(
    path.join(dir, 'attempts.jsonl'),
    attempts.map((t) => JSON.stringify(t)).join('\n') + '\n',
  );
  return dir;
}

// Runs the CLI in-process; returns { status, stdout, stderr } like spawnSync.
export function runCli(args) {
  const out = [];
  const err = [];
  const status = main(args, {
    stdout: (s) => out.push(s),
    stderr: (s) => err.push(s),
  });
  return { status, stdout: out.join('\n'), stderr: err.join('\n') };
}

export function runWorld(dir) {
  return runCli([
    'run',
    '--recipes', path.join(dir, 'recipes.json'),
    '--approvals', path.join(dir, 'approvals.jsonl'),
    '--attempts', path.join(dir, 'attempts.jsonl'),
    '--out', path.join(dir, 'allow.jsonl'),
    '--proof', path.join(dir, 'proof'),
  ]);
}

export function auditWorld(dir) {
  return runCli([
    'audit',
    '--recipes', path.join(dir, 'recipes.json'),
    '--approvals', path.join(dir, 'approvals.jsonl'),
    '--attempts', path.join(dir, 'attempts.jsonl'),
    '--allow', path.join(dir, 'allow.jsonl'),
    '--proof', path.join(dir, 'proof'),
  ]);
}

export function readJsonl(p) {
  return fs
    .readFileSync(p, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

export function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}
