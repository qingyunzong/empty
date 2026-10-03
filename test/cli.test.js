import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../src/cli.js';

const SCRIPT = `
customer C1001;
note_whitelist /^REQ-[0-9]+$/;
bucket loan limit 1000;
scope branch {
  cap loan 800;
}
`;

const EVENTS = [
  { id: 'e1', ts: '2026-10-01T09:00:00Z', type: 'freeze', bucket: 'loan', amount: 800, note: 'REQ-1', until: '2026-10-03', scope: 'branch' },
  { id: 'e2', ts: '2026-10-01T09:00:00Z', type: 'freeze', bucket: 'loan', amount: 800, note: 'REQ-2', until: '2026-10-03', scope: 'branch' },
  { id: 'e3', ts: '2026-10-04T00:00:00Z', type: 'draw', bucket: 'loan', ref: 'REQ-1', amount: 10 },
];

function capture() {
  const lines = { out: [], err: [] };
  return {
    lines,
    out: (s) => lines.out.push(s),
    err: (s) => lines.err.push(s),
    text: () => lines.out.join('\n'),
    errText: () => lines.err.join('\n'),
  };
}

test('CLI: quota apply + quota replay 端到端', () => {
  const dir = mkdtempSync(join(tmpdir(), 'quota-'));
  const scriptPath = join(dir, 'script.qta');
  const eventsPath = join(dir, 'events.jsonl');
  const statePath = join(dir, 'state.json');
  writeFileSync(scriptPath, SCRIPT);
  writeFileSync(eventsPath, EVENTS.map((e) => JSON.stringify(e)).join('\n') + '\n');

  const c1 = capture();
  const code1 = runCli(['apply', scriptPath, eventsPath, '--out', statePath], c1.out, c1.err);
  assert.equal(code1, 0);
  assert.match(c1.text(), /applied 1\/3 events \(2 failed\)/);
  assert.match(c1.text(), /E_CAP/);
  assert.ok(existsSync(statePath));

  const saved = JSON.parse(readFileSync(statePath, 'utf8'));
  assert.equal(saved.buckets.loan.available, 1000); // 到期日 00:00 批量释放 800
  assert.equal(saved.buckets.loan.frozen, 0);
  const e3 = saved.log.find((l) => l.id === 'e3');
  assert.equal(e3.code, 'E_EXPIRED');

  const c2 = capture();
  const code2 = runCli(['replay', statePath], c2.out, c2.err);
  assert.equal(code2, 0);
  assert.match(c2.text(), /REPLAY OK: 3 events re-applied/);
});

test('CLI: 脚本编译错误返回码 1 并打印错误码', () => {
  const dir = mkdtempSync(join(tmpdir(), 'quota-'));
  const scriptPath = join(dir, 'bad.qta');
  const eventsPath = join(dir, 'events.jsonl');
  writeFileSync(scriptPath, 'bucket loan limit 100;\nscope s { cap loan 200; }\n');
  writeFileSync(eventsPath, '');
  const c = capture();
  const code = runCli(['apply', scriptPath, eventsPath, '--out', join(dir, 's.json')], c.out, c.err);
  assert.equal(code, 1);
  assert.match(c.errText(), /E_SCOPE/);
});

test('CLI: replay 检测篡改后的状态不一致', () => {
  const dir = mkdtempSync(join(tmpdir(), 'quota-'));
  const scriptPath = join(dir, 'script.qta');
  const eventsPath = join(dir, 'events.jsonl');
  const statePath = join(dir, 'state.json');
  writeFileSync(scriptPath, SCRIPT);
  writeFileSync(eventsPath, EVENTS.map((e) => JSON.stringify(e)).join('\n') + '\n');
  const c1 = capture();
  runCli(['apply', scriptPath, eventsPath, '--out', statePath], c1.out, c1.err);

  const saved = JSON.parse(readFileSync(statePath, 'utf8'));
  saved.buckets.loan.available = 42; // 篡改
  writeFileSync(statePath, JSON.stringify(saved));

  const c2 = capture();
  const code = runCli(['replay', statePath], c2.out, c2.err);
  assert.equal(code, 1);
  assert.match(c2.errText(), /REPLAY FAILED: mismatches in buckets/);
});
