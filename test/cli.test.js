'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync, spawnSync } = require('node:child_process');

const CLI = path.join(__dirname, '..', 'cli.js');

function makeInDir(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'toollife-in-'));
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content);
  }
  return dir;
}

const TOOLS = JSON.stringify({
  materials: { steel: 1, aluminum: 0.5 },
  tools: [{ tool_id: 'T1', max_life: 100 }, { tool_id: 'T2', max_life: 60, life: 20 }],
});

test('CLI: toollife --in dir --out out produces tools_state.json and history.jsonl', () => {
  const inDir = makeInDir({
    'tools.json': TOOLS,
    'operations.jsonl': [
      JSON.stringify({ op_id: 'c1', tool_id: 'T1', type: 'cut', material: 'steel', amount: 30 }),
      JSON.stringify({ op_id: 'c2', tool_id: 'T2', type: 'cut', material: 'aluminum', amount: 10 }),
      JSON.stringify({ op_id: 'g1', tool_id: 'T2', type: 'regrind', restore: 8 }),
    ].join('\n') + '\n',
    'undo.jsonl': JSON.stringify({ undo_id: 'u1', op_id: 'c1' }) + '\n',
  });
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'toollife-out-')) + '/out';
  const res = spawnSync(process.execPath, [CLI, 'toollife', '--in', inDir, '--out', outDir], { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);

  const state = JSON.parse(fs.readFileSync(path.join(outDir, 'tools_state.json'), 'utf8'));
  const t1 = state.tools.find((t) => t.tool_id === 'T1');
  const t2 = state.tools.find((t) => t.tool_id === 'T2');
  assert.equal(t1.life, 100);          // 100 - 30, then undo -> +30
  assert.equal(t2.life, 23);           // 20 - 5 + 8
  assert.equal(t1.overused, false);

  const history = fs.readFileSync(path.join(outDir, 'history.jsonl'), 'utf8')
    .trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(history.filter((h) => h.kind === 'op').length, 3);
  assert.equal(history.find((h) => h.kind === 'undo').status, 'UNDONE');
});

test('CLI: unknown tool exits with code 2', () => {
  const inDir = makeInDir({
    'tools.json': TOOLS,
    'operations.jsonl': JSON.stringify({ op_id: 'c1', tool_id: 'NOPE', type: 'cut', material: 'steel', amount: 5 }) + '\n',
  });
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'toollife-out-')) + '/out';
  const res = spawnSync(process.execPath, [CLI, 'toollife', '--in', inDir, '--out', outDir], { encoding: 'utf8' });
  assert.equal(res.status, 2);
  assert.match(res.stderr, /unknown tool: NOPE/);
});

test('CLI: missing undo.jsonl is treated as empty; bad usage exits 1', () => {
  const inDir = makeInDir({
    'tools.json': TOOLS,
    'operations.jsonl': JSON.stringify({ op_id: 'c1', tool_id: 'T1', type: 'cut', material: 'steel', amount: 10 }) + '\n',
  });
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'toollife-out-')) + '/out';
  const res = spawnSync(process.execPath, [CLI, 'toollife', '--in', inDir, '--out', outDir], { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  const state = JSON.parse(fs.readFileSync(path.join(outDir, 'tools_state.json'), 'utf8'));
  assert.equal(state.tools.find((t) => t.tool_id === 'T1').life, 90);

  const bad = spawnSync(process.execPath, [CLI, 'toollife'], { encoding: 'utf8' });
  assert.equal(bad.status, 1);
});
