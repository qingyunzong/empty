import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cli } from './cli.test.js';
import { proofOf } from '../src/util.js';

const COMMANDS = [
  ['book', 'b1', '--group', 'alpha', '--objective', '20x', '--channels', 'GFP', '--fields', '4', '--priority', '1'],
  ['book', 'b2', '--group', 'beta', '--objective', '40x', '--channels', 'DAPI', '--fields', '3', '--priority', '0'],
  ['book', 'b3', '--group', 'alpha', '--objective', '20x', '--channels', 'Cy5', '--fields', '2', '--priority', '1'],
  ['scan', '--until', '3'],
  ['correct', 'b2', '--delta', '2'],
  ['maintain', '--start', '6', '--end', '8'],
  ['correct', 'b1', '--delta', '-1'],
  ['cancel', 'b3'],
  ['scan'],
];

function runAll(d, cmds) {
  for (const c of cmds) {
    const r = cli([...c, '--state', 'state.json'], d);
    assert.equal(r.code, 0, `命令失败: ${c.join(' ')}\n${r.err}`);
  }
  return proofOf(JSON.parse(readFileSync(join(d, 'state.json'), 'utf8')));
}

test('验收4: replay 从故障点恢复与连续运行一致', () => {
  const dirA = mkdtempSync(join(tmpdir(), 'microA-'));
  const proofA = runAll(dirA, COMMANDS);

  for (const crashAt of [2, 5, 7]) {
    const dirB = mkdtempSync(join(tmpdir(), 'microB-'));
    runAll(dirB, COMMANDS.slice(0, crashAt)); // 故障点前的连续运行
    rmSync(join(dirB, 'state.json')); // 模拟崩溃丢失状态
    const r = cli(['replay', '--state', 'state.json'], dirB);
    assert.equal(r.code, 0, r.err);
    const proofB = runAll(dirB, COMMANDS.slice(crashAt)); // 恢复后继续
    assert.equal(proofB, proofA, `故障点 seq<=${crashAt} 恢复后与连续运行不一致`);
    rmSync(dirB, { recursive: true, force: true });
  }
  rmSync(dirA, { recursive: true, force: true });
});

test('replay 校验状态证明，篡改即失败', () => {
  const d = mkdtempSync(join(tmpdir(), 'microC-'));
  runAll(d, COMMANDS.slice(0, 3));
  const logPath = join(d, 'state.json.log');
  const lines = readFileSync(logPath, 'utf8').split('\n').filter(Boolean);
  const ev = JSON.parse(lines[2]);
  ev.args.fields = 99; // 篡改事件
  lines[2] = JSON.stringify(ev);
  rmSync(logPath);
  writeFileSync(logPath, lines.join('\n') + '\n');
  rmSync(join(d, 'state.json'));
  const r = cli(['replay', '--state', 'state.json'], d);
  assert.equal(r.code, 1);
  assert.match(r.err, /PROOF_MISMATCH/);
  rmSync(d, { recursive: true, force: true });
});
