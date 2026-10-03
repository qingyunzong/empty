'use strict';

const fs = require('node:fs');
const path = require('node:path');

const STAGES = ['VALIDATED', 'FROZEN', 'POSTED', 'NOTIFIED'];
const TERMINAL = new Set(['CANCELLED', 'REFUNDED', 'FAILED']);

const DEFAULT_ACCOUNTS = {
  payer: { available: 1000, frozen: 0 },
  payee: { available: 0, frozen: 0 },
};

class WorkflowError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// Append-only event log + derived snapshot in a state directory.
class Store {
  constructor(dir) {
    this.dir = dir;
    this.logPath = path.join(dir, 'events.jsonl');
    this.snapshotPath = path.join(dir, 'state.json');
    fs.mkdirSync(dir, { recursive: true });
  }

  append(event) {
    const fd = fs.openSync(this.logPath, 'a');
    try {
      fs.writeSync(fd, JSON.stringify(event) + '\n');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }

  readEvents() {
    if (!fs.existsSync(this.logPath)) return [];
    return fs
      .readFileSync(this.logPath, 'utf8')
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line));
  }

  writeSnapshot(state) {
    const tmp = this.snapshotPath + '.tmp';
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeSync(fd, JSON.stringify(state, null, 2) + '\n');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, this.snapshotPath);
  }
}

function applyStage(state, payment, stage) {
  const accounts = state.accounts;
  switch (stage) {
    case 'VALIDATED':
      payment.status = 'VALIDATED';
      if (accounts.payer.available < payment.amount) payment.status = 'FAILED';
      break;
    case 'FROZEN':
      accounts.payer.available -= payment.amount;
      accounts.payer.frozen += payment.amount;
      payment.status = 'FROZEN';
      break;
    case 'POSTED':
      accounts.payer.frozen -= payment.amount;
      accounts.payee.available += payment.amount;
      payment.status = 'POSTED';
      break;
    case 'NOTIFIED':
      state.notifications.push({ paymentId: payment.paymentId, amount: payment.amount });
      payment.status = 'NOTIFIED';
      break;
  }
  payment.stages.push(stage);
}

// Pure reduction of the event log into derived state. Replaying is the
// recovery mechanism: a persisted stage event takes effect exactly once.
function reduce(events) {
  const state = { accounts: null, payments: {}, notifications: [], commands: {} };
  for (const event of events) {
    switch (event.type) {
      case 'INIT':
        if (!state.accounts) state.accounts = event.accounts;
        break;
      case 'COMMAND': {
        if (state.commands[event.commandId]) break;
        state.commands[event.commandId] = { type: event.commandType, paymentId: event.paymentId };
        if (event.commandType === 'PAY' && !state.payments[event.paymentId]) {
          state.payments[event.paymentId] = {
            paymentId: event.paymentId,
            amount: event.amount,
            status: 'PENDING',
            stages: [],
          };
        }
        break;
      }
      case 'STAGE': {
        const payment = state.payments[event.paymentId];
        if (!payment || TERMINAL.has(payment.status)) break;
        if (payment.stages.includes(event.stage)) break;
        if (STAGES[payment.stages.length] !== event.stage) break;
        applyStage(state, payment, event.stage);
        break;
      }
      case 'CANCELLED': {
        const payment = state.payments[event.paymentId];
        if (!payment || TERMINAL.has(payment.status)) break;
        if (payment.status === 'FROZEN') {
          state.accounts.payer.frozen -= payment.amount;
          state.accounts.payer.available += payment.amount;
        }
        payment.status = 'CANCELLED';
        break;
      }
      case 'REFUNDED': {
        const payment = state.payments[event.paymentId];
        if (!payment || TERMINAL.has(payment.status)) break;
        if (payment.status === 'POSTED' || payment.status === 'NOTIFIED') {
          state.accounts.payee.available -= payment.amount;
          state.accounts.payer.available += payment.amount;
          payment.status = 'REFUNDED';
        }
        break;
      }
    }
  }
  return state;
}

function ensureInit(store) {
  if (!fs.existsSync(store.logPath)) {
    store.append({ type: 'INIT', accounts: DEFAULT_ACCOUNTS });
  }
}

function certificate(state, cmd) {
  const payment = state.payments[cmd.paymentId];
  return {
    ok: true,
    commandId: cmd.commandId,
    paymentId: cmd.paymentId,
    status: payment ? payment.status : 'UNKNOWN',
    stages: payment ? payment.stages.slice() : [],
    balances: state.accounts,
    notifications: state.notifications.length,
  };
}

// Runs (or resumes) the four-stage payment workflow. Returns
// { crashed: true, stage } when the crash point is hit: the stage event is
// already persisted, but the derived state has not been applied yet.
function runPayment(store, cmd, crashPoint) {
  ensureInit(store);
  let state = reduce(store.readEvents());

  if (!state.payments[cmd.paymentId]) {
    if (state.commands[cmd.commandId]) {
      throw new WorkflowError('COMMAND_CONFLICT', `commandId ${cmd.commandId} already used`);
    }
    store.append({
      type: 'COMMAND',
      commandId: cmd.commandId,
      commandType: 'PAY',
      paymentId: cmd.paymentId,
      amount: cmd.amount,
    });
  }

  for (const stage of STAGES) {
    state = reduce(store.readEvents());
    const payment = state.payments[cmd.paymentId];
    if (TERMINAL.has(payment.status)) break;
    if (payment.stages.includes(stage)) continue;
    store.append({ type: 'STAGE', paymentId: cmd.paymentId, stage });
    if (crashPoint === stage) {
      return { crashed: true, stage };
    }
    state = reduce(store.readEvents());
    store.writeSnapshot({ accounts: state.accounts, payments: state.payments, notifications: state.notifications });
  }

  state = reduce(store.readEvents());
  store.writeSnapshot({ accounts: state.accounts, payments: state.payments, notifications: state.notifications });
  return certificate(state, cmd);
}

function runCancel(store, cmd) {
  ensureInit(store);
  let state = reduce(store.readEvents());

  if (state.commands[cmd.commandId]) {
    return certificate(state, cmd);
  }
  const payment = state.payments[cmd.paymentId];
  if (!payment) {
    throw new WorkflowError('PAYMENT_NOT_FOUND', `unknown paymentId ${cmd.paymentId}`);
  }

  store.append({ type: 'COMMAND', commandId: cmd.commandId, commandType: 'CANCEL', paymentId: cmd.paymentId });

  if (!TERMINAL.has(payment.status)) {
    if (payment.status === 'POSTED' || payment.status === 'NOTIFIED') {
      store.append({ type: 'REFUNDED', paymentId: cmd.paymentId, commandId: cmd.commandId });
    } else {
      store.append({ type: 'CANCELLED', paymentId: cmd.paymentId, commandId: cmd.commandId });
    }
  }

  state = reduce(store.readEvents());
  store.writeSnapshot({ accounts: state.accounts, payments: state.payments, notifications: state.notifications });
  return certificate(state, cmd);
}

module.exports = { STAGES, Store, WorkflowError, reduce, runPayment, runCancel };
