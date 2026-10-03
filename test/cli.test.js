'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { main } = require('../index');

function runCli(args) {
  const logs = [];
  const errs = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...a) => logs.push(a.join(' '));
  console.error = (...a) => errs.push(a.join(' '));
  try {
    const code = main(args);
    return { code, stdout: logs.join('\n'), stderr: errs.join('\n') };
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
}

function withTmp(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'restate-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const OK_INPUT = {
  items: [
    { id: 'cash', side: 'asset', domain: [-100, 100] },
    { id: 'equity', side: 'equity', domain: [-100, 100] },
  ],
  balances: { cash: 100, equity: 90 },
  periods: [{ id: 'P1', status: 'open' }],
  formulas: [{ id: 'bs', lhs: ['cash'], rhs: ['equity'] }],
  layers: [{ id: 'L1', formulas: ['bs'], reserve: 10 }],
};

test('CLI: node . restate 正常求解并写出结果', () => {
  withTmp((dir) => {
    const input = path.join(dir, 'input.json');
    const output = path.join(dir, 'output.json');
    fs.writeFileSync(input, JSON.stringify(OK_INPUT));
    const r = runCli(['restate', input, output]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /status=OK/);
    const out = JSON.parse(fs.readFileSync(output, 'utf8'));
    assert.equal(out.status, 'OK');
    assert.equal(out.period, 'P1');
    assert.deepEqual(out.items.sort(), ['cash', 'equity']);
    assert.equal(out.entry.lines.reduce((s, l) => s + l.amount, 0), 0);
    assert.equal(out.layers[0].status, 'PUBLISHED');
    assert.equal(out.reversals, 0);
    assert.equal(out.conflict, null);
  });
});

test('CLI: 引用不存在的公式退出码 1', () => {
  withTmp((dir) => {
    const bad = Object.assign({}, OK_INPUT, { constraints: { formulas: ['nope'] } });
    const input = path.join(dir, 'input.json');
    fs.writeFileSync(input, JSON.stringify(bad));
    const r = runCli(['restate', input, path.join(dir, 'out.json')]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /不存在的勾稽公式 nope/);
  });
});

test('CLI: 发布层引用不存在的公式退出码 1', () => {
  withTmp((dir) => {
    const bad = Object.assign({}, OK_INPUT, {
      layers: [{ id: 'L1', formulas: ['ghost'], reserve: 1 }],
    });
    const input = path.join(dir, 'input.json');
    fs.writeFileSync(input, JSON.stringify(bad));
    const r = runCli(['restate', input, path.join(dir, 'out.json')]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /不存在的勾稽公式 ghost/);
  });
});

test('CLI: 目标期间非法退出码 1', () => {
  withTmp((dir) => {
    const bad = Object.assign({}, OK_INPUT, { constraints: { period: 'QX' } });
    const input = path.join(dir, 'input.json');
    fs.writeFileSync(input, JSON.stringify(bad));
    const r = runCli(['restate', input, path.join(dir, 'out.json')]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /期间非法/);
  });
});

test('CLI: 未知命令、参数缺失或输入不可读退出码 1', () => {
  assert.equal(runCli(['bogus']).code, 1);
  assert.equal(runCli(['restate']).code, 1);
  const r = runCli(['restate', '/no/such/file.json', '/tmp/x.json']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /无法读取输入/);
});
