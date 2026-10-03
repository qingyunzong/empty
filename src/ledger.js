import { createHash } from 'node:crypto';

export class InvalidCommand extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvalidCommand';
    this.code = 'INVALID_COMMAND';
  }
}

export const INVARIANTS = Object.freeze([
  'NET_PLUS_FROZEN_WITHIN_LIMIT',
  'CORRECTION_OPPOSITE_SIGN',
  'VOLUME_REPLAYABLE',
]);

export function canonicalCommand(cmd) {
  if (cmd === null || typeof cmd !== 'object') return String(cmd);
  switch (cmd.op) {
    case 'post':
      return `post(id=${cmd.id},account=${cmd.account},amount=${cmd.amount})`;
    case 'cancel':
      return `cancel(postId=${cmd.postId})`;
    case 'freeze':
      return `freeze(account=${cmd.account},amount=${cmd.amount})`;
    default:
      return JSON.stringify(cmd);
  }
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function isValidAmount(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function validateLimits(limits) {
  if (limits === undefined || limits === null) return {};
  if (typeof limits !== 'object' || Array.isArray(limits)) {
    throw new InvalidCommand('limits must be an object mapping account to limit');
  }
  for (const [account, limit] of Object.entries(limits)) {
    if (!isNonEmptyString(account)) {
      throw new InvalidCommand('limits contains an invalid account key');
    }
    if (!isValidAmount(limit) || limit < 0) {
      throw new InvalidCommand(`limit for account ${account} must be a non-negative finite number`);
    }
  }
  return { ...limits };
}

function getAccount(accounts, name) {
  let acc = accounts.get(name);
  if (!acc) {
    acc = { postedNet: 0, frozen: 0 };
    accounts.set(name, acc);
  }
  return acc;
}

function applyCommand(state, cmd, index) {
  if (cmd === null || typeof cmd !== 'object' || Array.isArray(cmd)) {
    throw new InvalidCommand(`command #${index} must be an object`);
  }
  switch (cmd.op) {
    case 'post': {
      if (!isNonEmptyString(cmd.id)) {
        throw new InvalidCommand(`command #${index}: post requires a non-empty string id`);
      }
      if (!isNonEmptyString(cmd.account)) {
        throw new InvalidCommand(`command #${index}: post requires a non-empty string account`);
      }
      if (!isValidAmount(cmd.amount) || cmd.amount < 0) {
        throw new InvalidCommand(`command #${index}: post amount must be a non-negative finite number`);
      }
      if (state.entries.has(cmd.id)) {
        throw new InvalidCommand(`command #${index}: duplicate id ${cmd.id}`);
      }
      const acc = getAccount(state.accounts, cmd.account);
      acc.postedNet += cmd.amount;
      state.volume += cmd.amount;
      const entry = { seq: state.trail.length, type: 'post', id: cmd.id, account: cmd.account, amount: cmd.amount };
      state.trail.push(entry);
      state.entries.set(cmd.id, { entry, cancelled: false, isCorrection: false });
      break;
    }
    case 'cancel': {
      if (!isNonEmptyString(cmd.postId)) {
        throw new InvalidCommand(`command #${index}: cancel requires a non-empty string postId`);
      }
      const target = state.entries.get(cmd.postId);
      if (!target) {
        throw new InvalidCommand(`command #${index}: cancel references unknown id ${cmd.postId}`);
      }
      if (target.isCorrection) {
        throw new InvalidCommand(`command #${index}: cyclic correction on ${cmd.postId} is not allowed`);
      }
      if (target.cancelled) {
        throw new InvalidCommand(`command #${index}: cyclic correction, ${cmd.postId} is already cancelled`);
      }
      target.cancelled = true;
      const original = target.entry;
      const correctionId = `${cmd.postId}#correction`;
      const acc = getAccount(state.accounts, original.account);
      acc.postedNet -= original.amount;
      const entry = {
        seq: state.trail.length,
        type: 'correction',
        id: correctionId,
        ref: cmd.postId,
        account: original.account,
        amount: -original.amount,
      };
      state.trail.push(entry);
      state.entries.set(correctionId, { entry, cancelled: false, isCorrection: true });
      break;
    }
    case 'freeze': {
      if (!isNonEmptyString(cmd.account)) {
        throw new InvalidCommand(`command #${index}: freeze requires a non-empty string account`);
      }
      if (!isValidAmount(cmd.amount) || cmd.amount < 0) {
        throw new InvalidCommand(`command #${index}: freeze amount must be a non-negative finite number`);
      }
      const acc = getAccount(state.accounts, cmd.account);
      acc.frozen += cmd.amount;
      state.trail.push({ seq: state.trail.length, type: 'freeze', account: cmd.account, amount: cmd.amount });
      break;
    }
    default:
      throw new InvalidCommand(`command #${index}: unknown op ${JSON.stringify(cmd.op)}`);
  }
}

function checkLimitInvariant(state, limits, index, cmd) {
  for (const [name, acc] of state.accounts) {
    const limit = Object.hasOwn(limits, name) ? limits[name] : Infinity;
    if (acc.postedNet + acc.frozen > limit) {
      state.violations.push({
        invariant: 'NET_PLUS_FROZEN_WITHIN_LIMIT',
        index,
        command: canonicalCommand(cmd),
        account: name,
        postedNet: acc.postedNet,
        frozen: acc.frozen,
        limit,
      });
    }
  }
}

function checkCorrectionInvariant(state) {
  for (const record of state.entries.values()) {
    if (!record.isCorrection) continue;
    const original = state.entries.get(record.entry.ref);
    if (!original || record.entry.amount !== -original.entry.amount) {
      state.violations.push({
        invariant: 'CORRECTION_OPPOSITE_SIGN',
        index: record.entry.seq,
        correction: record.entry.id,
        ref: record.entry.ref,
        amount: record.entry.amount,
        expected: original ? -original.entry.amount : null,
      });
    }
  }
}

function replayTrail(trail) {
  const accounts = new Map();
  let volume = 0;
  for (const entry of trail) {
    const acc = getAccount(accounts, entry.account);
    if (entry.type === 'post') {
      acc.postedNet += entry.amount;
      volume += entry.amount;
    } else if (entry.type === 'correction') {
      acc.postedNet += entry.amount;
    } else if (entry.type === 'freeze') {
      acc.frozen += entry.amount;
    }
  }
  return { accounts, volume };
}

export function replayHashOf(trail) {
  const canonical = trail.map((entry) => {
    const out = { seq: entry.seq, type: entry.type };
    for (const key of Object.keys(entry).sort()) {
      if (key === 'seq' || key === 'type') continue;
      out[key] = entry[key];
    }
    return out;
  });
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

function snapshotState(state, limits) {
  const accounts = {};
  const names = [...new Set([...state.accounts.keys(), ...Object.keys(limits)])].sort();
  for (const name of names) {
    const acc = state.accounts.get(name) ?? { postedNet: 0, frozen: 0 };
    const limited = Object.hasOwn(limits, name);
    const limit = limited ? limits[name] : null;
    accounts[name] = {
      postedNet: acc.postedNet,
      frozen: acc.frozen,
      limit,
      available: limited ? limit - acc.postedNet - acc.frozen : null,
    };
  }
  return { accounts, volume: state.volume };
}

export function runBatch(commands, rawLimits = {}) {
  if (!Array.isArray(commands)) {
    throw new InvalidCommand('commands must be an array');
  }
  const limits = validateLimits(rawLimits);
  const state = {
    accounts: new Map(),
    entries: new Map(),
    trail: [],
    volume: 0,
    violations: [],
  };
  commands.forEach((cmd, index) => {
    applyCommand(state, cmd, index);
    checkLimitInvariant(state, limits, index, cmd);
  });
  checkCorrectionInvariant(state);

  const replayed = replayTrail(state.trail);
  if (replayed.volume !== state.volume) {
    state.violations.push({
      invariant: 'VOLUME_REPLAYABLE',
      expected: state.volume,
      replayed: replayed.volume,
    });
  }
  for (const [name, acc] of state.accounts) {
    const rep = replayed.accounts.get(name);
    if (!rep || rep.postedNet !== acc.postedNet || rep.frozen !== acc.frozen) {
      state.violations.push({
        invariant: 'VOLUME_REPLAYABLE',
        account: name,
        expected: { postedNet: acc.postedNet, frozen: acc.frozen },
        replayed: rep ? { postedNet: rep.postedNet, frozen: rep.frozen } : null,
      });
    }
  }

  return {
    ok: state.violations.length === 0,
    violations: state.violations,
    finalState: snapshotState(state, limits),
    trail: state.trail.map((entry) => ({ ...entry })),
    replayHash: replayHashOf(state.trail),
  };
}
