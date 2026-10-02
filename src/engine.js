import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export class SimulatedCrash extends Error {
  constructor(seq) {
    super(`simulated crash after account #${seq} record persisted`);
    this.name = 'SimulatedCrash';
    this.seq = seq;
  }
}

export function computeCertificate({ callId, targetAmount, freezes }) {
  const canonical = JSON.stringify({
    callId,
    targetAmount,
    status: 'CONFIRMED',
    freezes: freezes.map((f) => ({ accountId: f.accountId, amount: f.amount })),
  });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

function validateEvent(event) {
  if (event === null || typeof event !== 'object' || Array.isArray(event)) {
    throw new Error('event must be a JSON object');
  }
  const {
    callId,
    targetAmount,
    accounts,
    crashAfterAccount = null,
    cancelAfterAccount = null,
  } = event;
  if (typeof callId !== 'string' || callId.length === 0) {
    throw new Error('callId must be a non-empty string');
  }
  if (!/^[A-Za-z0-9_-]+$/.test(callId)) {
    throw new Error('callId may only contain [A-Za-z0-9_-]');
  }
  if (!Number.isFinite(targetAmount) || targetAmount <= 0) {
    throw new Error('targetAmount must be a positive number');
  }
  if (!Array.isArray(accounts) || accounts.length === 0) {
    throw new Error('accounts must be a non-empty array');
  }
  const seen = new Set();
  for (const account of accounts) {
    if (account === null || typeof account !== 'object' || Array.isArray(account)) {
      throw new Error('each account must be an object');
    }
    if (typeof account.id !== 'string' || account.id.length === 0) {
      throw new Error('account.id must be a non-empty string');
    }
    if (seen.has(account.id)) {
      throw new Error(`duplicate account id: ${account.id}`);
    }
    seen.add(account.id);
    if (!Number.isInteger(account.priority)) {
      throw new Error(`account ${account.id}: priority must be an integer`);
    }
    if (!Number.isFinite(account.available) || account.available < 0) {
      throw new Error(`account ${account.id}: available must be a non-negative number`);
    }
  }
  for (const [name, value] of [
    ['crashAfterAccount', crashAfterAccount],
    ['cancelAfterAccount', cancelAfterAccount],
  ]) {
    if (value !== null && (!Number.isInteger(value) || value < 0)) {
      throw new Error(`${name} must be null or a non-negative integer`);
    }
  }
  return { callId, targetAmount, accounts, crashAfterAccount, cancelAfterAccount };
}

function sortAccounts(accounts) {
  return [...accounts].sort(
    (x, y) => x.priority - y.priority || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0),
  );
}

function snapshotAccounts(sorted) {
  return sorted.map((a) => ({
    id: a.id,
    priority: a.priority,
    available: a.available,
    failFreeze: a.failFreeze === true,
  }));
}

function appendRecord(file, record) {
  const fd = fs.openSync(file, 'a');
  try {
    fs.writeSync(fd, JSON.stringify(record) + '\n');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function readRecords(file) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

export class MarginCallEngine {
  constructor(logDir) {
    this.logDir = logDir;
    fs.mkdirSync(logDir, { recursive: true });
  }

  journalPath(callId) {
    return path.join(this.logDir, `${callId}.jsonl`);
  }

  run(event) {
    const { callId, targetAmount, accounts, crashAfterAccount, cancelAfterAccount } =
      validateEvent(event);
    const sorted = sortAccounts(accounts);
    const file = this.journalPath(callId);
    const records = readRecords(file);

    const started = records.find((r) => r.type === 'call-started');
    if (!started) {
      appendRecord(file, {
        type: 'call-started',
        callId,
        targetAmount,
        accounts: snapshotAccounts(sorted),
      });
    } else if (
      started.targetAmount !== targetAmount ||
      JSON.stringify(started.accounts) !== JSON.stringify(snapshotAccounts(sorted))
    ) {
      throw new Error(`callId "${callId}" already exists with different parameters`);
    }

    const completed = records.find((r) => r.type === 'completed');
    if (completed) return completed.result;

    const attempts = records.filter((r) => r.type === 'attempt');
    let processed = attempts.length;
    let remaining = targetAmount - attempts.reduce((sum, a) => sum + a.amount, 0);
    let cancelled = records.some((r) => r.type === 'cancel-received');

    while (!cancelled && remaining > 0 && processed < sorted.length) {
      if (cancelAfterAccount !== null && processed >= cancelAfterAccount) {
        appendRecord(file, { type: 'cancel-received', afterAccount: processed });
        cancelled = true;
        break;
      }
      const account = sorted[processed];
      const amount =
        account.failFreeze === true ? 0 : Math.min(account.available, remaining);
      const record = {
        type: 'attempt',
        seq: processed + 1,
        accountId: account.id,
        amount,
        success: amount > 0,
      };
      appendRecord(file, record);
      attempts.push(record);
      processed += 1;
      remaining -= amount;
      if (crashAfterAccount !== null && processed === crashAfterAccount) {
        throw new SimulatedCrash(processed);
      }
    }

    const freezes = attempts
      .filter((a) => a.amount > 0)
      .map((a) => ({ accountId: a.accountId, amount: a.amount }));
    const totalFrozen = freezes.reduce((sum, f) => sum + f.amount, 0);

    let status;
    if (cancelled) status = 'CANCELLED';
    else if (totalFrozen >= targetAmount) status = 'CONFIRMED';
    else status = 'FAILED';

    const rollbacks = [];
    if (status !== 'CONFIRMED') {
      for (const freeze of [...freezes].reverse()) {
        appendRecord(file, {
          type: 'rollback',
          accountId: freeze.accountId,
          amount: freeze.amount,
        });
        rollbacks.push(freeze);
      }
    }

    const result = {
      callId,
      status,
      targetAmount,
      totalFrozen: status === 'CONFIRMED' ? totalFrozen : 0,
      freezes,
      rollbacks,
      certificate:
        status === 'CONFIRMED'
          ? computeCertificate({ callId, targetAmount, freezes })
          : null,
    };
    appendRecord(file, { type: 'completed', status, result });
    return result;
  }
}
