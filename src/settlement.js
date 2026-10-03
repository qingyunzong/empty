import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const STATUSES = Object.freeze(['PENDING', 'FROZEN', 'SETTLED', 'COMPENSATED', 'FAILED']);

export class SettlementError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function createState(accounts = {}) {
  const balances = {};
  for (const [name, available] of Object.entries(accounts)) {
    if (!Number.isInteger(available) || available < 0) {
      throw new SettlementError('INVALID_INPUT', `invalid initial balance for account ${name}`);
    }
    balances[name] = { available, frozen: 0 };
  }
  return { accounts: balances, settlements: {}, certificates: {}, seq: 0 };
}

function getAccount(state, account) {
  const entry = state.accounts[account];
  if (!entry) {
    throw new SettlementError('UNKNOWN_ACCOUNT', `unknown account: ${account}`);
  }
  return entry;
}

function getSettlement(state, key) {
  const settlement = state.settlements[key];
  if (!settlement) {
    throw new SettlementError('ILLEGAL_TRANSITION', `no settlement for key: ${key}`);
  }
  return settlement;
}

function assertStatus(settlement, expected, eventType) {
  if (settlement.status !== expected) {
    throw new SettlementError(
      'ILLEGAL_TRANSITION',
      `event ${eventType} requires status ${expected}, got ${settlement.status}`,
    );
  }
}

export function applyEvent(state, event) {
  if (!event || !Number.isInteger(event.seq) || event.seq < 1) {
    throw new SettlementError('INVALID_EVENT', 'event must have a positive integer seq');
  }
  switch (event.type) {
    case 'FREEZE': {
      if (state.settlements[event.idempotencyKey]) {
        throw new SettlementError('ILLEGAL_TRANSITION', `duplicate FREEZE for key ${event.idempotencyKey}`);
      }
      const account = getAccount(state, event.account);
      if (account.available < event.amount) {
        throw new SettlementError('INSUFFICIENT_FUNDS', `available ${account.available} < ${event.amount}`);
      }
      account.available -= event.amount;
      account.frozen += event.amount;
      state.settlements[event.idempotencyKey] = {
        idempotencyKey: event.idempotencyKey,
        account: event.account,
        amount: event.amount,
        status: 'FROZEN',
        payablePosted: false,
        payableFailed: false,
      };
      break;
    }
    case 'PAYABLE_POSTED': {
      const settlement = getSettlement(state, event.idempotencyKey);
      assertStatus(settlement, 'FROZEN', event.type);
      if (settlement.payablePosted || settlement.payableFailed) {
        throw new SettlementError('ILLEGAL_TRANSITION', 'payable already recorded');
      }
      settlement.payablePosted = true;
      break;
    }
    case 'PAYABLE_FAILED': {
      const settlement = getSettlement(state, event.idempotencyKey);
      assertStatus(settlement, 'FROZEN', event.type);
      if (settlement.payablePosted || settlement.payableFailed) {
        throw new SettlementError('ILLEGAL_TRANSITION', 'payable already recorded');
      }
      settlement.payableFailed = true;
      break;
    }
    case 'UNFREEZE': {
      const settlement = getSettlement(state, event.idempotencyKey);
      assertStatus(settlement, 'FROZEN', event.type);
      const account = getAccount(state, settlement.account);
      account.frozen -= settlement.amount;
      account.available += settlement.amount;
      settlement.status = 'COMPENSATED';
      break;
    }
    case 'SETTLED': {
      const settlement = getSettlement(state, event.idempotencyKey);
      assertStatus(settlement, 'FROZEN', event.type);
      if (!settlement.payablePosted) {
        throw new SettlementError('ILLEGAL_TRANSITION', 'cannot settle before payable is posted');
      }
      const account = getAccount(state, settlement.account);
      account.frozen -= settlement.amount;
      settlement.status = 'SETTLED';
      break;
    }
    case 'FAILED': {
      const settlement = getSettlement(state, event.idempotencyKey);
      assertStatus(settlement, 'COMPENSATED', event.type);
      settlement.status = 'FAILED';
      break;
    }
    default:
      throw new SettlementError('INVALID_EVENT', `unknown event type: ${event.type}`);
  }
  state.seq = event.seq;
  if (event.type === 'SETTLED' || event.type === 'FAILED') {
    recordCertificate(state, event.idempotencyKey);
  }
  return state;
}

function recordCertificate(state, key) {
  if (state.certificates[key]) return;
  const settlement = state.settlements[key];
  if (!settlement || (settlement.status !== 'SETTLED' && settlement.status !== 'FAILED')) return;
  const account = state.accounts[settlement.account];
  state.certificates[key] = {
    idempotencyKey: key,
    account: settlement.account,
    amount: settlement.amount,
    status: settlement.status,
    lastSeq: state.seq,
    balances: { available: account.available, frozen: account.frozen },
    hash: computeHash(state),
  };
}

export function validateCommand(command) {
  if (!command || typeof command !== 'object') {
    throw new SettlementError('INVALID_INPUT', 'command must be an object');
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
}

export function executeCommand(state, command, emit) {
  validateCommand(command);
  const existing = state.certificates[command.idempotencyKey];
  if (existing) {
    return existing;
  }
  const target = getAccount(state, command.account);
  if (target.available < command.amount) {
    throw new SettlementError(
      'INSUFFICIENT_FUNDS',
      `available ${target.available} < ${command.amount}`,
    );
  }

  const publish = (type) => {
    const event = {
      seq: state.seq + 1,
      type,
      idempotencyKey: command.idempotencyKey,
      account: command.account,
      amount: command.amount,
    };
    emit(event);
    applyEvent(state, event);
    return event;
  };

  publish('FREEZE');
  if (command.failPost === true) {
    publish('PAYABLE_FAILED');
    publish('UNFREEZE');
    publish('FAILED');
  } else {
    publish('PAYABLE_POSTED');
    publish('SETTLED');
  }

  return state.certificates[command.idempotencyKey];
}

function canonical(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function canonicalState(state) {
  return canonical({
    accounts: state.accounts,
    settlements: state.settlements,
    seq: state.seq,
  });
}

export function computeHash(state) {
  return createHash('sha256').update(canonicalState(state)).digest('hex');
}

export function replayEvents(events, accounts = {}) {
  const state = createState(accounts);
  const bySeq = new Map();
  for (const event of events) {
    if (!event || !Number.isInteger(event.seq)) {
      throw new SettlementError('INVALID_EVENT', 'log event missing integer seq');
    }
    if (!bySeq.has(event.seq)) {
      bySeq.set(event.seq, event);
    }
  }
  const ordered = [...bySeq.values()].sort((a, b) => a.seq - b.seq);
  for (let i = 0; i < ordered.length; i += 1) {
    if (ordered[i].seq !== i + 1) {
      throw new SettlementError('LOG_CORRUPT', `event sequence gap at ${i + 1}`);
    }
    applyEvent(state, ordered[i]);
  }
  return state;
}

export const EVENTS_FILE = 'events.jsonl';
export const ACCOUNTS_FILE = 'accounts.json';

export function initLogDir(dir, accounts) {
  fs.mkdirSync(dir, { recursive: true });
  const state = createState(accounts);
  fs.writeFileSync(path.join(dir, ACCOUNTS_FILE), `${JSON.stringify(accounts)}\n`);
  return state;
}

export function loadLogDir(dir) {
  const accountsPath = path.join(dir, ACCOUNTS_FILE);
  if (!fs.existsSync(accountsPath)) {
    throw new SettlementError('NOT_INITIALIZED', `log dir not initialized: ${dir}`);
  }
  let accounts;
  try {
    accounts = JSON.parse(fs.readFileSync(accountsPath, 'utf8'));
  } catch {
    throw new SettlementError('LOG_CORRUPT', 'accounts.json is not valid JSON');
  }
  const eventsPath = path.join(dir, EVENTS_FILE);
  const events = [];
  if (fs.existsSync(eventsPath)) {
    const lines = fs.readFileSync(eventsPath, 'utf8').split('\n').filter((line) => line.trim() !== '');
    for (const line of lines) {
      try {
        events.push(JSON.parse(line));
      } catch {
        throw new SettlementError('LOG_CORRUPT', 'events.jsonl contains invalid JSON');
      }
    }
  }
  return replayEvents(events, accounts);
}

export function makeFileEmitter(dir) {
  const eventsPath = path.join(dir, EVENTS_FILE);
  return (event) => {
    fs.appendFileSync(eventsPath, `${JSON.stringify(event)}\n`);
  };
}
