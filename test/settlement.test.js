'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const CLI = path.join(__dirname, '..', 'src', 'cli.js');
const {
  createState,
  applyEvent,
  SettlementError,
} = require('../src/settlement');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'settle-'));
}

let outCounter = 0;
// 沙箱环境中子进程管道输出会丢失，改为重定向到临时文件再读取
function runCli(args) {
  outCounter += 1;
  const outFile = path.join(os.tmpdir(), `cli-out-${process.pid}-${outCounter}.txt`);
  const fd = fs.openSync(outFile, 'w');
  const res = spawnSync(process.execPath, [CLI, ...args], { stdio: ['ignore', fd, fd] });
  fs.closeSync(fd);
  const stdout = fs.readFileSync(outFile, 'utf8');
  fs.unlinkSync(outFile);
  return { code: res.status, stdout: stdout.trim() };
}

function submit(logDir, command) {
  const inputFile = path.join(logDir, `input-${command.idempotencyKey}.json`);
  fs.mkdirSync(logDir, { recursive: true });
  fs.writeFileSync(inputFile, JSON.stringify(command));
  return runCli(['submit', '--log', logDir, '--input', inputFile]);
}

function rebuild(logDir) {
  const res = runCli(['rebuild', '--log', logDir]);
  assert.equal(res.code, 0, res.stdout);
  return JSON.parse(res.stdout);
}

function readLog(logDir) {
  return fs.readFileSync(path.join(logDir, 'events.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
}

// 测试侧独立实现的规范化序列化与哈希（不引用被测代码的哈希逻辑）
function canon(value) {
  if (Array.isArray(value)) return '[' + value.map(canon).join(',') + ']';
  if (value !== null && typeof value === 'object') {
    return '{' + Object.keys(value).sort()
      .map((k) => JSON.stringify(k) + ':' + canon(value[k]))
      .join(',') + '}';
  }
  return JSON.stringify(value);
}

function expectedHash(accounts, workflows) {
  return crypto.createHash('sha256').update(canon({ accounts, workflows })).digest('hex');
}

test('正常结算：余额、事件序号与状态哈希正确', () => {
  const dir = tmpDir();
  const res = submit(dir, { idempotencyKey: 'k1', account: 'acct', amount: 250 });
  assert.equal(res.code, 0, res.stdout);
  const cert = JSON.parse(res.stdout);
  assert.equal(cert.status, 'SETTLED');
  assert.equal(cert.idempotencyKey, 'k1');

  const events = readLog(dir);
  assert.deepEqual(events.map((e) => e.seq), [1, 2, 3, 4]);
  assert.deepEqual(events.map((e) => e.type), ['OPEN', 'FREEZE', 'POST', 'CONFIRM']);
  assert.deepEqual(cert.events, [2, 3, 4]);

  const state = rebuild(dir);
  assert.equal(state.accounts.acct.balance, 9750);
  assert.equal(state.accounts.acct.frozen, 0);
  assert.equal(state.accounts.acct.settled, 250);
  assert.equal(state.workflows.k1.status, 'SETTLED');

  const hash = expectedHash(
    { acct: { balance: 9750, frozen: 0, settled: 250 } },
    { k1: { account: 'acct', amount: 250, status: 'SETTLED', posted: true } },
  );
  assert.equal(state.stateHash, hash);
  assert.equal(cert.stateHash, hash);
});

test('重复幂等键与旧日志重放只产生一次效果', () => {
  const dir = tmpDir();
  const cmd = { idempotencyKey: 'dup-1', account: 'acct', amount: 700 };
  const first = submit(dir, cmd);
  assert.equal(first.code, 0, first.stdout);
  const second = submit(dir, cmd);
  assert.equal(second.code, 0, second.stdout);
  assert.deepEqual(JSON.parse(second.stdout), JSON.parse(first.stdout));

  // 日志未追加新事件，只扣款一次
  assert.equal(readLog(dir).length, 4);
  const state = rebuild(dir);
  assert.equal(state.accounts.acct.balance, 9300);
  assert.equal(state.accounts.acct.settled, 700);

  // 用旧日志复制件重放：状态一致，再提交同键仍返回原证书且不追加事件
  const copyDir = tmpDir();
  fs.copyFileSync(path.join(dir, 'events.jsonl'), path.join(copyDir, 'events.jsonl'));
  const replayed = rebuild(copyDir);
  assert.equal(replayed.stateHash, state.stateHash);
  assert.equal(replayed.accounts.acct.balance, 9300);
  const third = submit(copyDir, cmd);
  assert.equal(third.code, 0, third.stdout);
  assert.deepEqual(JSON.parse(third.stdout), JSON.parse(first.stdout));
  assert.equal(readLog(copyDir).length, 4);
  assert.equal(rebuild(copyDir).accounts.acct.balance, 9300);
});

test('failPost：日志含解冻补偿，最终 FAILED 且额度还原', () => {
  const dir = tmpDir();
  const res = submit(dir, { idempotencyKey: 'fail-1', account: 'acct', amount: 400, failPost: true });
  assert.equal(res.code, 0, res.stdout);
  const cert = JSON.parse(res.stdout);
  assert.equal(cert.status, 'FAILED');

  const events = readLog(dir);
  assert.deepEqual(events.map((e) => e.type), ['OPEN', 'FREEZE', 'COMPENSATE', 'FAIL']);
  assert.ok(events.some((e) => e.type === 'COMPENSATE'), '日志必须包含解冻补偿事件');
  assert.ok(!events.some((e) => e.type === 'CONFIRM'), '失败流程绝不能确认结算');

  const state = rebuild(dir);
  assert.equal(state.workflows['fail-1'].status, 'FAILED');
  assert.equal(state.accounts.acct.balance, 10000);
  assert.equal(state.accounts.acct.frozen, 0);
  assert.equal(state.accounts.acct.settled, 0);
});

test('乱序重复事件重放与新建结果一致', () => {
  const dir = tmpDir();
  submit(dir, { idempotencyKey: 's1', account: 'acct', amount: 100 });
  submit(dir, { idempotencyKey: 's2', account: 'acct', amount: 200, failPost: true });
  submit(dir, { idempotencyKey: 's3', account: 'acct2', amount: 50 });
  const fresh = rebuild(dir);

  const lines = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').trim().split('\n');
  // 乱序 + 重复若干行
  const shuffled = [lines[5], lines[2], lines[9], lines[0], lines[7], lines[2],
    lines[11], lines[4], lines[1], lines[8], lines[0], lines[10], lines[3], lines[6]];
  const messyDir = tmpDir();
  fs.writeFileSync(path.join(messyDir, 'events.jsonl'), shuffled.join('\n') + '\n');

  const replayed = rebuild(messyDir);
  assert.equal(replayed.stateHash, fresh.stateHash);
  assert.deepEqual(replayed.accounts, fresh.accounts);
  assert.deepEqual(replayed.workflows, fresh.workflows);
  assert.equal(replayed.lastSeq, fresh.lastSeq);
});

test('枚举器：三个指令全部到达顺序余额一致', () => {
  // 独立枚举器：不引用被测代码，自行计算期望余额
  const commands = [
    { idempotencyKey: 'A', account: 'acct', amount: 100 },
    { idempotencyKey: 'B', account: 'acct', amount: 200 },
    { idempotencyKey: 'C', account: 'acct', amount: 300, failPost: true },
  ];
  const INITIAL = 10000;
  // 独立期望：A、B 结算成功，C 登记失败并补偿解冻
  const expectedBalance = INITIAL - 100 - 200;
  const expectedSettled = 100 + 200;

  function permutations(items) {
    if (items.length <= 1) return [items.slice()];
    const out = [];
    for (let i = 0; i < items.length; i += 1) {
      const rest = items.slice(0, i).concat(items.slice(i + 1));
      for (const tail of permutations(rest)) out.push([items[i], ...tail]);
    }
    return out;
  }

  const orders = permutations(commands);
  assert.equal(orders.length, 6);
  const hashes = new Set();
  for (const order of orders) {
    const dir = tmpDir();
    for (const cmd of order) {
      const res = submit(dir, cmd);
      assert.equal(res.code, 0, `order ${order.map((c) => c.idempotencyKey)}: ${res.stdout}`);
    }
    const state = rebuild(dir);
    assert.equal(state.accounts.acct.balance, expectedBalance);
    assert.equal(state.accounts.acct.frozen, 0);
    assert.equal(state.accounts.acct.settled, expectedSettled);
    assert.equal(state.workflows.A.status, 'SETTLED');
    assert.equal(state.workflows.B.status, 'SETTLED');
    assert.equal(state.workflows.C.status, 'FAILED');
    hashes.add(state.stateHash);
  }
  assert.equal(hashes.size, 1, '所有到达顺序的状态哈希必须一致');
});

test('非法状态转移返回 ILLEGAL_TRANSITION', () => {
  const state = createState();
  applyEvent(state, { seq: 1, type: 'OPEN', account: 'acct', amount: 1000 });
  applyEvent(state, { seq: 2, type: 'FREEZE', key: 'k', account: 'acct', amount: 100 });
  // 未登记应付账款直接确认 -> 非法
  assert.throws(
    () => applyEvent(state, { seq: 3, type: 'CONFIRM', key: 'k', account: 'acct', amount: 100 }),
    (err) => err instanceof SettlementError && err.code === 'ILLEGAL_TRANSITION',
  );
  // 重复冻结同键 -> 非法
  assert.throws(
    () => applyEvent(state, { seq: 3, type: 'FREEZE', key: 'k', account: 'acct', amount: 100 }),
    (err) => err instanceof SettlementError && err.code === 'ILLEGAL_TRANSITION',
  );
  // 终态后任何转移 -> 非法
  applyEvent(state, { seq: 3, type: 'COMPENSATE', key: 'k', account: 'acct', amount: 100 });
  applyEvent(state, { seq: 4, type: 'FAIL', key: 'k', account: 'acct', amount: 100 });
  assert.throws(
    () => applyEvent(state, { seq: 5, type: 'CONFIRM', key: 'k', account: 'acct', amount: 100 }),
    (err) => err instanceof SettlementError && err.code === 'ILLEGAL_TRANSITION',
  );
});

test('错误输出格式：退出码 1 且输出 {"error","message"}', () => {
  const dir = tmpDir();
  // 非法输入：金额非整数
  const bad = submit(dir, { idempotencyKey: 'bad', account: 'acct', amount: 12.5 });
  assert.equal(bad.code, 1);
  const badBody = JSON.parse(bad.stdout);
  assert.equal(badBody.error, 'INVALID_INPUT');
  assert.equal(typeof badBody.message, 'string');

  // 余额不足
  const poor = submit(dir, { idempotencyKey: 'poor', account: 'acct', amount: 999999 });
  assert.equal(poor.code, 1);
  assert.equal(JSON.parse(poor.stdout).error, 'INSUFFICIENT_FUNDS');

  // 未知命令
  const unknown = runCli(['frobnicate', '--log', dir]);
  assert.equal(unknown.code, 1);
  assert.equal(JSON.parse(unknown.stdout).error, 'UNKNOWN_COMMAND');

  // 输入文件不存在
  const missing = runCli(['submit', '--log', dir, '--input', path.join(dir, 'nope.json')]);
  assert.equal(missing.code, 1);
  assert.equal(JSON.parse(missing.stdout).error, 'INVALID_INPUT');
});
