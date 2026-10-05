'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { main } = require('../index');

function runCli(args) {
  const errors = [];
  const code = main(['node', '.', ...args], (msg) => errors.push(msg));
  return { code, stderr: errors.join('\n') };
}

function tmpFile(dir, name, content) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, content);
  return p;
}

const validInput = {
  accounts: [
    { id: 'A1', cash: 10000 },
    { id: 'A2', securities: { SEC1: 100 } },
    { id: 'A3', cash: 2000 },
    { id: 'A4', securities: { SEC2: 200 } },
  ],
  instructions: [
    { id: 'B1', side: 'buy', security: 'SEC1', price: 10, quantity: 100 },
    { id: 'S1', side: 'sell', security: 'SEC1', price: 10, quantity: 100 },
    { id: 'B2', side: 'buy', security: 'SEC2', price: 5, quantity: 200 },
    { id: 'S2', side: 'sell', security: 'SEC2', price: 5, quantity: 200 },
  ],
  permissions: { B1: ['A1'], S1: ['A2'], B2: ['A3'], S2: ['A4'] },
};

test('CLI: node . deliver 正常交收并写出结果', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-'));
  const input = tmpFile(dir, 'input.json', JSON.stringify(validInput));
  const output = path.join(dir, 'output.json');
  const r = runCli(['deliver', input, output]);
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(fs.readFileSync(output, 'utf8'));
  assert.equal(out.status, 'OK');
  assert.equal(out.pairs.length, 2);
  assert.equal(out.frozen.A1.cash, 1000);
});

test('CLI: 坏 JSON 退出码 1', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-'));
  const input = tmpFile(dir, 'bad.json', '{ not json');
  const r = runCli(['deliver', input, path.join(dir, 'out.json')]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /JSON/);
});

test('CLI: 单边指令退出码 1', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-'));
  const bad = {
    accounts: [{ id: 'A1', cash: 1000 }],
    instructions: [{ id: 'X1', side: 'hold', security: 'SEC1', price: 10, quantity: 1 }],
  };
  const input = tmpFile(dir, 'input.json', JSON.stringify(bad));
  const r = runCli(['deliver', input, path.join(dir, 'out.json')]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /单边|方向/);
});

test('CLI: 余额不足输出 UNSAT（退出码 0）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-'));
  const unsat = {
    accounts: [{ id: 'A1', cash: 500 }, { id: 'A2', securities: { SEC1: 100 } }],
    instructions: [
      { id: 'B1', side: 'buy', security: 'SEC1', price: 10, quantity: 100 },
      { id: 'S1', side: 'sell', security: 'SEC1', price: 10, quantity: 100 },
    ],
    permissions: { B1: ['A1'], S1: ['A2'] },
  };
  const input = tmpFile(dir, 'input.json', JSON.stringify(unsat));
  const output = path.join(dir, 'output.json');
  const r = runCli(['deliver', input, output]);
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(fs.readFileSync(output, 'utf8'));
  assert.equal(out.status, 'UNSAT');
  assert.deepEqual(out.conflict.cycle, ['B1']);
});

test('CLI: 撤单后增量重配', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-'));
  const input = tmpFile(dir, 'input.json', JSON.stringify({ ...validInput, cancellations: ['S2'] }));
  const output = path.join(dir, 'output.json');
  const r = runCli(['deliver', input, output]);
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(fs.readFileSync(output, 'utf8'));
  assert.equal(out.status, 'OK');
  assert.equal(out.pairs.length, 1);
  assert.equal(out.pairs[0].buy, 'B1');
  assert.deepEqual(out.unmatched, ['B2']);
  assert.equal(out.remaining.A3.cash, 2000); // 已解冻
});
