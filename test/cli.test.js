'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { run } = require('../src/cli');

function runCli(args) {
  const stdout = [];
  const stderr = [];
  const status = run(args, { out: (l) => stdout.push(l), err: (l) => stderr.push(l) });
  return { status, stdout, stderr };
}

function withInput(lines) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wx-')), 'in.jsonl');
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return file;
}

test('CLI 正常处理：会话到 stdout，错误行到 stderr，退出码 0', () => {
  const file = withInput([
    '{"op":"UPSERT","id":"a","station":"s1","eventTime":"2026-01-01T00:00:00Z","temp":10,"version":1}',
    '{"op":"UPSERT","id":"b","station":"s1","eventTime":"2026-01-01T00:05:00Z","temp":20,"version":1}',
    '{"op":"WATERMARK","ts":"2026-01-01T00:20:00Z"}',
    '{"op":"UPSERT","id":"late","station":"s1","eventTime":"2026-01-01T00:01:00Z","temp":1,"version":1}',
    '{"op":"RETRACT","id":"ghost","version":1}',
  ]);
  const r = runCli(['sessions', '--in', file]);
  assert.equal(r.status, 0);
  assert.equal(r.stdout.length, 1);
  const session = JSON.parse(r.stdout[0]);
  assert.equal(session.station, 's1');
  assert.equal(session.count, 2);
  assert.equal(session.avgTemp, 15);
  assert.deepEqual(session.ids, ['a', 'b']);
  const errs = r.stderr.map(JSON.parse);
  assert.deepEqual(errs.map((e) => e.error), ['LATE', 'UNKNOWN_RETRACT']);
  assert.equal(errs[0].line, 4);
  assert.equal(errs[1].line, 5);
});

test('CLI 致命错误退出码 2：缺少 --in / 文件不存在 / 非法 JSON / 未知 op / 缺字段', () => {
  assert.equal(runCli(['sessions']).status, 2);
  assert.equal(runCli(['sessions', '--in', '/nonexistent/file.jsonl']).status, 2);
  assert.equal(runCli(['bogus', '--in', 'x']).status, 2);

  const badJson = withInput(['{not json']);
  const r1 = runCli(['sessions', '--in', badJson]);
  assert.equal(r1.status, 2);
  assert.equal(JSON.parse(r1.stderr.at(-1)).error, 'FATAL');

  const badOp = withInput(['{"op":"DELETE","id":"a"}']);
  assert.equal(runCli(['sessions', '--in', badOp]).status, 2);

  const missingField = withInput(['{"op":"UPSERT","id":"a","station":"s1","version":1}']);
  assert.equal(runCli(['sessions', '--in', missingField]).status, 2);
});

test('CLI 支持 epoch 毫秒时间戳', () => {
  const file = withInput([
    '{"op":"UPSERT","id":"a","station":"s1","eventTime":1767225600000,"temp":7,"version":1}',
    '{"op":"WATERMARK","ts":1767225600000}',
    '{"op":"WATERMARK","ts":1767226200001}',
  ]);
  const r = runCli(['sessions', '--in', file]);
  assert.equal(r.status, 0);
  assert.equal(r.stdout.length, 1);
  const session = JSON.parse(r.stdout[0]);
  assert.equal(session.start, '2026-01-01T00:00:00.000Z');
  assert.equal(session.avgTemp, 7);
});
