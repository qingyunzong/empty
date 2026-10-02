'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_BALANCE = 10000;
const LOG_FILE = 'events.jsonl';

const STATUSES = Object.freeze(['PENDING', 'FROZEN', 'SETTLED', 'COMPENSATED', 'FAILED']);

// 合法状态转移表：事件类型 -> 下一状态
const TRANSITIONS = Object.freeze({
  PENDING: Object.freeze({ FREEZE: 'FROZEN' }),
  FROZEN: Object.freeze({ POST: 'FROZEN', CONFIRM: 'SETTLED', COMPENSATE: 'COMPENSATED' }),
  COMPENSATED: Object.freeze({ FAIL: 'FAILED' }),
  SETTLED: Object.freeze({}),
  FAILED: Object.freeze({}),
});

class SettlementError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SettlementError';
    this.code = code;
  }
}

function canonicalize(value) {
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalize).join(',') + ']';
  }
  if (value !== null && typeof value === 'object') {
    return '{' + Object.keys(value).sort()
      .map((k) => JSON.stringify(k) + ':' + canonicalize(value[k]))
      .join(',') + '}';
  }
  return JSON.stringify(value);
}

function createState() {
  return { accounts: {}, workflows: {}, lastSeq: 0 };
}

function transition(workflow, eventType) {
  const next = (TRANSITIONS[workflow.status] || {})[eventType];
  if (!next) {
    throw new SettlementError(
      'ILLEGAL_TRANSITION',
      `cannot apply ${eventType} to workflow ${workflow.key} in status ${workflow.status}`,
    );
  }
  workflow.status = next;
}

function applyEvent(state, event) {
  const { type, key, account, amount, seq } = event;
  switch (type) {
    case 'OPEN': {
      if (state.accounts[account]) {
        throw new SettlementError('ILLEGAL_TRANSITION', `account ${account} already open`);
      }
      state.accounts[account] = { balance: amount, frozen: 0, settled: 0 };
      return;
    }
    case 'FREEZE': {
      if (state.workflows[key]) {
        throw new SettlementError('ILLEGAL_TRANSITION', `workflow ${key} already exists`);
      }
      const acc = state.accounts[account];
      if (!acc) {
        throw new SettlementError('ILLEGAL_TRANSITION', `account ${account} is not open`);
      }
      if (acc.balance - acc.frozen < amount) {
        throw new SettlementError(
          'INSUFFICIENT_FUNDS',
          `account ${account} has ${acc.balance - acc.frozen} available, needs ${amount}`,
        );
      }
      const workflow = { key, account, amount, status: 'PENDING', posted: false, seqs: [] };
      state.workflows[key] = workflow;
      transition(workflow, 'FREEZE');
      acc.frozen += amount;
      workflow.seqs.push(seq);
      return;
    }
    case 'POST': {
      const workflow = state.workflows[key];
      if (!workflow) {
        throw new SettlementError('ILLEGAL_TRANSITION', `workflow ${key} does not exist`);
      }
      if (workflow.posted) {
        throw new SettlementError('ILLEGAL_TRANSITION', `workflow ${key} already posted`);
      }
      transition(workflow, 'POST');
      workflow.posted = true;
      workflow.seqs.push(seq);
      return;
    }
    case 'CONFIRM': {
      const workflow = state.workflows[key];
      if (!workflow) {
        throw new SettlementError('ILLEGAL_TRANSITION', `workflow ${key} does not exist`);
      }
      if (!workflow.posted) {
        throw new SettlementError('ILLEGAL_TRANSITION', `workflow ${key} confirmed before posting`);
      }
      transition(workflow, 'CONFIRM');
      const acc = state.accounts[workflow.account];
      acc.frozen -= workflow.amount;
      acc.balance -= workflow.amount;
      acc.settled += workflow.amount;
      workflow.seqs.push(seq);
      return;
    }
    case 'COMPENSATE': {
      const workflow = state.workflows[key];
      if (!workflow) {
        throw new SettlementError('ILLEGAL_TRANSITION', `workflow ${key} does not exist`);
      }
      transition(workflow, 'COMPENSATE');
      const acc = state.accounts[workflow.account];
      acc.frozen -= workflow.amount;
      workflow.seqs.push(seq);
      return;
    }
    case 'FAIL': {
      const workflow = state.workflows[key];
      if (!workflow) {
        throw new SettlementError('ILLEGAL_TRANSITION', `workflow ${key} does not exist`);
      }
      transition(workflow, 'FAIL');
      workflow.seqs.push(seq);
      return;
    }
    default:
      throw new SettlementError('ILLEGAL_TRANSITION', `unknown event type ${type}`);
  }
}

function validateCommand(command) {
  if (command === null || typeof command !== 'object' || Array.isArray(command)) {
    throw new SettlementError('INVALID_INPUT', 'command must be a JSON object');
  }
  if (typeof command.idempotencyKey !== 'string' || command.idempotencyKey.length === 0) {
    throw new SettlementError('INVALID_INPUT', 'idempotencyKey must be a non-empty string');
  }
  if (typeof command.account !== 'string' || command.account.length === 0) {
    throw new SettlementError('INVALID_INPUT', 'account must be a non-empty string');
  }
  if (!Number.isInteger(command.amount) || command.amount <= 0) {
    throw new SettlementError('INVALID_INPUT', 'amount must be a positive integer');
  }
  if (command.failPost !== undefined && typeof command.failPost !== 'boolean') {
    throw new SettlementError('INVALID_INPUT', 'failPost must be a boolean');
  }
  if (
    command.initialBalance !== undefined &&
    (!Number.isInteger(command.initialBalance) || command.initialBalance < 0)
  ) {
    throw new SettlementError('INVALID_INPUT', 'initialBalance must be a non-negative integer');
  }
}

// 投影出参与哈希的确定性状态（不含事件序号等顺序相关字段）
function hashProjection(state) {
  const accounts = {};
  for (const [name, acc] of Object.entries(state.accounts)) {
    accounts[name] = { balance: acc.balance, frozen: acc.frozen, settled: acc.settled };
  }
  const workflows = {};
  for (const [key, wf] of Object.entries(state.workflows)) {
    workflows[key] = { account: wf.account, amount: wf.amount, status: wf.status, posted: wf.posted };
  }
  return { accounts, workflows };
}

function hashState(state) {
  return crypto.createHash('sha256').update(canonicalize(hashProjection(state))).digest('hex');
}

function snapshot(state) {
  return { ...hashProjection(state), lastSeq: state.lastSeq, stateHash: hashState(state) };
}

function certificateFor(state, key) {
  const workflow = state.workflows[key];
  if (!workflow) {
    throw new SettlementError('UNKNOWN_KEY', `no workflow for idempotencyKey ${key}`);
  }
  return {
    idempotencyKey: workflow.key,
    account: workflow.account,
    amount: workflow.amount,
    status: workflow.status,
    events: workflow.seqs.slice(),
    stateHash: hashState(state),
  };
}

// persist: 每步先持久化事件，再更新内存状态
function executeCommand(state, command, persist) {
  validateCommand(command);
  const key = command.idempotencyKey;
  if (state.workflows[key]) {
    return { certificate: certificateFor(state, key), replayed: true };
  }

  const emit = (event) => {
    const full = { seq: state.lastSeq + 1, ...event };
    persist(full);
    applyEvent(state, full);
    state.lastSeq = full.seq;
  };

  if (!state.accounts[command.account]) {
    const opening = command.initialBalance !== undefined ? command.initialBalance : DEFAULT_BALANCE;
    emit({ type: 'OPEN', account: command.account, amount: opening });
  }
  const acc = state.accounts[command.account];
  if (acc.balance - acc.frozen < command.amount) {
    throw new SettlementError(
      'INSUFFICIENT_FUNDS',
      `account ${command.account} has ${acc.balance - acc.frozen} available, needs ${command.amount}`,
    );
  }

  emit({ type: 'FREEZE', key, account: command.account, amount: command.amount });
  if (command.failPost === true) {
    // 登记应付账款确定性失败：补偿解冻并标记 FAILED，绝不确认
    emit({ type: 'COMPENSATE', key, account: command.account, amount: command.amount });
    emit({ type: 'FAIL', key, account: command.account, amount: command.amount });
  } else {
    emit({ type: 'POST', key, account: command.account, amount: command.amount });
    emit({ type: 'CONFIRM', key, account: command.account, amount: command.amount });
  }
  return { certificate: certificateFor(state, key), replayed: false };
}

function logPath(logDir) {
  return path.join(logDir, LOG_FILE);
}

function appendEventToLog(logDir, event) {
  fs.mkdirSync(logDir, { recursive: true });
  fs.appendFileSync(logPath(logDir), JSON.stringify(event) + '\n');
}

function readEvents(logDir) {
  const file = logPath(logDir);
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

// 从日志目录重建：按 seq 去重并排序，容忍乱序与重复事件
function rebuildState(logDir) {
  const bySeq = new Map();
  for (const event of readEvents(logDir)) {
    if (!bySeq.has(event.seq)) bySeq.set(event.seq, event);
  }
  const ordered = [...bySeq.values()].sort((a, b) => a.seq - b.seq);
  const state = createState();
  for (const event of ordered) {
    applyEvent(state, event);
    if (event.seq > state.lastSeq) state.lastSeq = event.seq;
  }
  return state;
}

module.exports = {
  DEFAULT_BALANCE,
  LOG_FILE,
  STATUSES,
  TRANSITIONS,
  SettlementError,
  canonicalize,
  createState,
  applyEvent,
  validateCommand,
  executeCommand,
  certificateFor,
  hashProjection,
  hashState,
  snapshot,
  appendEventToLog,
  readEvents,
  rebuildState,
};
