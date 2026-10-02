'use strict';

const { createHash } = require('node:crypto');

class InvalidCommandError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvalidCommandError';
    this.code = 'INVALID_COMMAND';
  }
}

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
}

function isPositiveAmount(n) {
  return typeof n === 'number' && Number.isFinite(n) && n > 0;
}

function validateCommands(commands) {
  if (!Array.isArray(commands)) {
    throw new InvalidCommandError('commands must be an array');
  }
  const postIds = new Set();
  const cancelled = new Set();
  commands.forEach((cmd, index) => {
    if (cmd === null || typeof cmd !== 'object' || Array.isArray(cmd)) {
      throw new InvalidCommandError(`command[${index}] is not an object`);
    }
    switch (cmd.op) {
      case 'post': {
        if (typeof cmd.id !== 'string' || cmd.id.length === 0) {
          throw new InvalidCommandError(`command[${index}]: post requires a non-empty string id`);
        }
        if (postIds.has(cmd.id)) {
          throw new InvalidCommandError(`command[${index}]: duplicate post id "${cmd.id}"`);
        }
        if (typeof cmd.account !== 'string' || cmd.account.length === 0) {
          throw new InvalidCommandError(`command[${index}]: post requires an account`);
        }
        if (typeof cmd.amount !== 'number' || !Number.isFinite(cmd.amount)) {
          throw new InvalidCommandError(`command[${index}]: post amount must be a finite number`);
        }
        if (cmd.amount <= 0) {
          throw new InvalidCommandError(`command[${index}]: negative or zero amount ${cmd.amount}`);
        }
        postIds.add(cmd.id);
        break;
      }
      case 'cancel': {
        if (typeof cmd.postId !== 'string' || !postIds.has(cmd.postId)) {
          throw new InvalidCommandError(`command[${index}]: cancel references unknown post id "${cmd.postId}"`);
        }
        if (cancelled.has(cmd.postId)) {
          throw new InvalidCommandError(
            `command[${index}]: cyclic correction, post "${cmd.postId}" already cancelled`
          );
        }
        cancelled.add(cmd.postId);
        break;
      }
      case 'freeze': {
        if (typeof cmd.account !== 'string' || cmd.account.length === 0) {
          throw new InvalidCommandError(`command[${index}]: freeze requires an account`);
        }
        if (typeof cmd.amount !== 'number' || !Number.isFinite(cmd.amount)) {
          throw new InvalidCommandError(`command[${index}]: freeze amount must be a finite number`);
        }
        if (cmd.amount <= 0) {
          throw new InvalidCommandError(`command[${index}]: negative or zero amount ${cmd.amount}`);
        }
        break;
      }
      default:
        throw new InvalidCommandError(`command[${index}]: unknown op "${cmd.op}"`);
    }
  });
}

function limitFor(limits, account) {
  if (limits && typeof limits === 'object' && account in limits) {
    const limit = limits[account];
    if (typeof limit !== 'number' || !Number.isFinite(limit) || limit < 0) {
      throw new InvalidCommandError(`invalid limit for account "${account}"`);
    }
    return limit;
  }
  return Infinity;
}

// Execute a validated command sequence, building the audit ledger and
// checking invariants after every entry.
function runCommands(commands, limits) {
  validateCommands(commands);
  const accounts = new Map();
  const posts = new Map();
  const ledger = [];
  const violations = [];

  const accountOf = (name) => {
    if (!accounts.has(name)) {
      accounts.set(name, { posted: 0, frozen: 0, limit: limitFor(limits, name) });
    }
    return accounts.get(name);
  };

  const checkLimit = (name, seq) => {
    const acc = accountOf(name);
    if (acc.posted + acc.frozen > acc.limit) {
      violations.push({
        invariant: 'limit',
        seq,
        account: name,
        posted: acc.posted,
        frozen: acc.frozen,
        limit: acc.limit,
      });
    }
  };

  commands.forEach((cmd, index) => {
    if (cmd.op === 'post') {
      const acc = accountOf(cmd.account);
      acc.posted += cmd.amount;
      posts.set(cmd.id, { account: cmd.account, amount: cmd.amount });
      ledger.push({ seq: index, type: 'post', id: cmd.id, account: cmd.account, amount: cmd.amount });
      checkLimit(cmd.account, index);
    } else if (cmd.op === 'cancel') {
      const original = posts.get(cmd.postId);
      const acc = accountOf(original.account);
      // Reversal correction: history is kept, a compensating entry is appended.
      const correction = {
        seq: index,
        type: 'correction',
        id: `correction:${cmd.postId}`,
        postId: cmd.postId,
        account: original.account,
        amount: -original.amount,
      };
      if (correction.amount >= 0 || correction.amount !== -original.amount) {
        violations.push({ invariant: 'correction-sign', seq: index, postId: cmd.postId });
      }
      acc.posted -= original.amount;
      ledger.push(correction);
      checkLimit(original.account, index);
    } else if (cmd.op === 'freeze') {
      const acc = accountOf(cmd.account);
      acc.frozen += cmd.amount;
      ledger.push({ seq: index, type: 'freeze', account: cmd.account, amount: cmd.amount });
      checkLimit(cmd.account, index);
    }
  });

  const finalState = {};
  for (const [name, acc] of [...accounts.entries()].sort()) {
    finalState[name] = {
      posted: acc.posted,
      frozen: acc.frozen,
      limit: acc.limit === Infinity ? null : acc.limit,
      available: acc.limit === Infinity ? null : acc.limit - acc.posted - acc.frozen,
    };
  }

  // Invariant: cumulative totals must be replayable from the ledger alone.
  const replayed = {};
  for (const entry of ledger) {
    const totals = replayed[entry.account] || (replayed[entry.account] = { posted: 0, frozen: 0 });
    if (entry.type === 'post') totals.posted += entry.amount;
    else if (entry.type === 'correction') totals.posted += entry.amount;
    else if (entry.type === 'freeze') totals.frozen += entry.amount;
  }
  for (const [name, acc] of accounts) {
    const totals = replayed[name] || { posted: 0, frozen: 0 };
    if (totals.posted !== acc.posted || totals.frozen !== acc.frozen) {
      violations.push({ invariant: 'replay', account: name });
    }
  }

  return {
    ok: violations.length === 0,
    violations,
    ledger,
    finalState,
    replayHash: hashLedger(ledger),
  };
}

function hashLedger(ledger) {
  const hash = createHash('sha256');
  for (const entry of ledger) hash.update(canonical(entry) + '\n');
  return hash.digest('hex');
}

module.exports = {
  InvalidCommandError,
  canonical,
  validateCommands,
  runCommands,
  hashLedger,
};
