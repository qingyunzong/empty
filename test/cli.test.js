import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runCli } from '../src/cli.js';

function setup(lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-life-'));
  const inDir = path.join(dir, 'in');
  const outDir = path.join(dir, 'out');
  fs.mkdirSync(inDir);
  fs.writeFileSync(path.join(inDir, 'events.jsonl'), lines.join('\n') + '\n');
  return { inDir, outDir };
}

function capture() {
  const lines = [];
  return { io: { stderr: (m) => lines.push(m) }, lines };
}

const readJsonl = (file) =>
  fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);

test('CLI tool life writes tools.jsonl, parts.jsonl, risk.json, late.log', () => {
  const { inDir, outDir } = setup([
    JSON.stringify({ type: 'change', eventTs: 0, tool: 'T1', newLife: 10, op: 'c1' }),
    JSON.stringify({ type: 'load', eventTs: 1, tool: 'T1', part: 'P1', force: 100, seconds: 2, op: 'l1' }),
    JSON.stringify({ type: 'load', eventTs: 20, tool: 'T1', part: 'P2', force: 100, seconds: 1, op: 'l2' }),
    JSON.stringify({ type: 'qc', eventTs: 2, part: 'P1', ok: false, op: 'q1' }), // late (watermark 16)
  ]);
  const { io, lines } = capture();
  const code = runCli(['life', '--in', inDir, '--out', outDir], io);
  assert.equal(code, 0);
  assert.deepEqual(lines, []);

  const tools = readJsonl(path.join(outDir, 'tools.jsonl'));
  assert.equal(tools.length, 1);
  assert.equal(tools[0].tool, 'T1');
  assert.equal(tools[0].status, 'OK');
  assert.equal(tools[0].remaining, 7);

  const parts = readJsonl(path.join(outDir, 'parts.jsonl'));
  assert.equal(parts.find((p) => p.part === 'P1').state, 'BAD');
  assert.equal(parts.find((p) => p.part === 'P2').risk, 'SUSPECT');

  const risk = JSON.parse(fs.readFileSync(path.join(outDir, 'risk.json'), 'utf8'));
  assert.equal(risk.watermark, 16);
  assert.deepEqual(risk.partsAtRisk, ['P2']);

  const late = readJsonl(path.join(outDir, 'late.log'));
  assert.equal(late.length, 1);
  assert.equal(late[0].op, 'q1');
});

test('CLI exits 1 and reports LIFE_INVALID for newLife <= 0', () => {
  const { inDir, outDir } = setup([
    JSON.stringify({ type: 'change', eventTs: 0, tool: 'T1', newLife: 0, op: 'c1' }),
  ]);
  const { io, lines } = capture();
  const code = runCli(['life', '--in', inDir, '--out', outDir], io);
  assert.equal(code, 1);
  assert.match(lines.join('\n'), /LIFE_INVALID/);
  const risk = JSON.parse(fs.readFileSync(path.join(outDir, 'risk.json'), 'utf8'));
  assert.equal(risk.errors[0].code, 'LIFE_INVALID');
});

test('CLI usage error without required args', () => {
  const { io, lines } = capture();
  assert.equal(runCli([], io), 2);
  assert.match(lines.join('\n'), /usage: tool life/);
});

test('CLI skips malformed JSONL lines with a warning', () => {
  const { inDir, outDir } = setup([
    JSON.stringify({ type: 'change', eventTs: 0, tool: 'T1', newLife: 10, op: 'c1' }),
    '{not json',
  ]);
  const { io, lines } = capture();
  const code = runCli(['life', '--in', inDir, '--out', outDir], io);
  assert.equal(code, 0);
  assert.match(lines.join('\n'), /PARSE_ERROR/);
});
