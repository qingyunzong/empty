import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const CLI = path.resolve(import.meta.dirname, '..', 'src', 'cli.js');

export function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'recipe-terminal-'));
}

export function writeJson(dir, name, data) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, JSON.stringify(data, null, 2));
  return p;
}

export function writeJsonl(dir, name, objs) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, objs.map((o) => JSON.stringify(o)).join('\n') + '\n');
  return p;
}

export function readJsonl(p) {
  const text = fs.readFileSync(p, 'utf8').trim();
  return text ? text.split('\n').map(JSON.parse) : [];
}

export function runCli(args) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
}

export function runWorld(dir, recipes, approvals, attempts) {
  const recipesPath = writeJson(dir, 'recipes.json', recipes);
  const approvalsPath = writeJsonl(dir, 'approvals.jsonl', approvals);
  const attemptsPath = writeJsonl(dir, 'attempts.jsonl', attempts);
  const out = path.join(dir, 'allow.jsonl');
  const proofdir = path.join(dir, 'proof');
  const res = runCli(['run', '--recipes', recipesPath, '--approvals', approvalsPath,
    '--attempts', attemptsPath, '--out', out, '--proofdir', proofdir]);
  return { res, out, proofdir, recipesPath, approvalsPath, attemptsPath };
}

export function baseRecipes(overrides = {}) {
  return {
    factory: 'F1',
    workshops: [
      { id: 'W1', reactors: ['K1', 'K2'] },
      { id: 'W2', reactors: ['K3'] },
    ],
    recipes: [
      { id: 'R1', versions: [1] },
      { id: 'R2', versions: [1] },
    ],
    forbidden: [],
    ...overrides,
  };
}
