import fs from 'node:fs';
import path from 'node:path';

export const STAGES = ['VALIDATED', 'FROZEN', 'POSTED', 'NOTIFIED'];
export const CRASH_EXIT_CODE = 99;
export const DEFAULT_INITIAL_BALANCE = 1000;

const LOG_FILE = 'events.log';

export class CliError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function logPath(stateDir) {
  return path.join(stateDir, LOG_FILE);
}

function appendEvent(stateDir, event) {
  const fd = fs.openSync(logPath(stateDir), 'a');
  try {
    fs.writeSync(fd, JSON.stringify(event) + '\n');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function emptyState() {
  return {
    accountInitialized: false,
    balance: 0,
    frozen: 0,
    payments: new Map(),
    processedCommandIds: new Set(),
  };
}

function applyEvent(state, event) {
  switch (event.type) {
    case 'INIT': {
      if (!state.accountInitialized) {
        state.accountInitialized = true;
        state.balance = event.initialBalance;
      }
      if (!state.payments.has(event.paymentId)) {
        state.payments.set(event.paymentId, {
          paymentId: event.paymentId,
          commandId: event.commandId,
          amount: event.amount,
          stagesDone: [],
          terminal: null,
        });
      }
      break;
    }
    case 'STAGE_BEGIN':
      break;
    case 'STAGE_DONE': {
      const payment = state.payments.get(event.paymentId);
      if (!payment || payment.stagesDone.includes(event.stage)) break;
      payment.stagesDone.push(event.stage);
      if (event.stage === 'FROZEN') state.frozen += payment.amount;
      if (event.stage === 'POSTED') {
        state.frozen -= payment.amount;
        state.balance -= payment.amount;
      }
      break;
    }
    case 'CANCELLED': {
      const payment = state.payments.get(event.paymentId);
      if (!payment || payment.terminal) break;
      payment.terminal = 'CANCELLED';
      if (payment.stagesDone.includes('FROZEN') && !payment.stagesDone.includes('POSTED')) {
        state.frozen -= payment.amount;
      }
      break;
    }
    case 'REFUNDED': {
      const payment = state.payments.get(event.paymentId);
      if (!payment || payment.terminal) break;
      payment.terminal = 'REFUNDED';
      state.balance += payment.amount;
      break;
    }
    default:
      break;
  }
  if (event.commandId) state.processedCommandIds.add(event.commandId);
}

export function loadState(stateDir) {
  const state = emptyState();
  const file = logPath(stateDir);
  if (!fs.existsSync(file)) return state;
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.length > 0);
  for (const line of lines) {
    applyEvent(state, JSON.parse(line));
  }
  return state;
}

export function readEvents(stateDir) {
  const file = logPath(stateDir);
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

export function certificate(state, paymentId) {
  const payment = state.payments.get(paymentId);
  const allDone = STAGES.every((stage) => payment.stagesDone.includes(stage));
  const status = payment.terminal ?? (allDone ? 'COMPLETED' : 'IN_PROGRESS');
  return {
    paymentId,
    status,
    stages: STAGES.filter((stage) => payment.stagesDone.includes(stage)),
    amount: payment.amount,
    balance: state.balance,
    frozen: state.frozen,
  };
}

function requireString(command, field) {
  if (typeof command[field] !== 'string' || command[field].length === 0) {
    throw new CliError('INVALID_COMMAND', `missing or invalid field: ${field}`);
  }
}

function executePay(stateDir, command) {
  requireString(command, 'paymentId');
  requireString(command, 'commandId');
  const { paymentId, commandId } = command;

  const state = loadState(stateDir);
  let payment = state.payments.get(paymentId);

  if (payment && payment.commandId !== commandId) {
    throw new CliError('DUPLICATE_PAYMENT', `paymentId ${paymentId} already exists with a different commandId`);
  }

  if (!payment) {
    if (typeof command.amount !== 'number' || !Number.isFinite(command.amount) || command.amount <= 0) {
      throw new CliError('INVALID_COMMAND', 'amount must be a positive number');
    }
    const initialBalance = command.initialBalance ?? DEFAULT_INITIAL_BALANCE;
    if (typeof initialBalance !== 'number' || initialBalance < command.amount) {
      throw new CliError('INSUFFICIENT_FUNDS', 'initial balance cannot cover amount');
    }
    const init = { type: 'INIT', paymentId, commandId, amount: command.amount, initialBalance };
    appendEvent(stateDir, init);
    applyEvent(state, init);
    payment = state.payments.get(paymentId);
  }

  if (payment.terminal) {
    return { certificate: certificate(state, paymentId) };
  }

  for (const stage of STAGES) {
    if (payment.stagesDone.includes(stage)) continue;
    if (command.pauseBefore === stage) {
      return { certificate: certificate(state, paymentId) };
    }
    appendEvent(stateDir, { type: 'STAGE_BEGIN', paymentId, commandId, stage });
    if (command.crashPoint === stage) {
      return { crash: stage };
    }
    const done = { type: 'STAGE_DONE', paymentId, commandId, stage };
    appendEvent(stateDir, done);
    applyEvent(state, done);
  }

  return { certificate: certificate(state, paymentId) };
}

function executeCancel(stateDir, command) {
  requireString(command, 'paymentId');
  requireString(command, 'commandId');
  const { paymentId, commandId } = command;

  const state = loadState(stateDir);
  const payment = state.payments.get(paymentId);
  if (!payment) {
    throw new CliError('PAYMENT_NOT_FOUND', `unknown paymentId ${paymentId}`);
  }

  if (state.processedCommandIds.has(commandId) || payment.terminal) {
    return { certificate: certificate(state, paymentId) };
  }

  if (payment.stagesDone.includes('POSTED')) {
    const refund = { type: 'REFUNDED', paymentId, commandId };
    appendEvent(stateDir, refund);
    applyEvent(state, refund);
  } else {
    const cancel = { type: 'CANCELLED', paymentId, commandId };
    appendEvent(stateDir, cancel);
    applyEvent(state, cancel);
  }

  return { certificate: certificate(state, paymentId) };
}

export function execute(stateDir, command) {
  if (command === null || typeof command !== 'object' || Array.isArray(command)) {
    throw new CliError('INVALID_COMMAND', 'command must be a JSON object');
  }
  switch (command.type) {
    case 'pay':
      return executePay(stateDir, command);
    case 'cancel':
      return executeCancel(stateDir, command);
    default:
      throw new CliError('INVALID_COMMAND', `unknown command type: ${String(command.type)}`);
  }
}
