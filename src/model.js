'use strict';

// Domain model: parsing, validation and the account state machine.
//
// Command shape (one JSON object per JSONL line):
//   { opId, session, start, end, action, account, amount, depends[] }
// An optional first line may declare initial balances:
//   { "type": "init", "balances": { "accA": 100 } }

const ACTIONS = new Set(['FREEZE', 'DEBIT', 'RELEASE', 'SETTLE']);

const EXIT = {
  OK: 0,
  USAGE: 2,
  INVALID_INTERVAL: 12,
  DEPENDS_CYCLE: 13,
  UNKNOWN_COMMAND: 14,
};

class JudgeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'JudgeError';
    this.code = code;
  }
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

// Parse JSONL text into { balances, commands }.
// Throws JudgeError(USAGE) on malformed input.
function parseHistory(text) {
  const balances = {};
  const commands = [];
  const lines = String(text).split(/\r?\n/);
  lines.forEach((raw, index) => {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) return;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch (err) {
      throw new JudgeError(EXIT.USAGE, `line ${index + 1}: invalid JSON: ${err.message}`);
    }
    if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
      throw new JudgeError(EXIT.USAGE, `line ${index + 1}: expected a JSON object`);
    }
    if (obj.type === 'init') {
      if (obj.balances === null || typeof obj.balances !== 'object' || Array.isArray(obj.balances)) {
        throw new JudgeError(EXIT.USAGE, `line ${index + 1}: init.balances must be an object`);
      }
      for (const [account, amount] of Object.entries(obj.balances)) {
        if (!isFiniteNumber(amount)) {
          throw new JudgeError(EXIT.USAGE, `line ${index + 1}: init balance for "${account}" must be a number`);
        }
        balances[account] = amount;
      }
      return;
    }
    commands.push(normalizeCommand(obj, index + 1));
  });
  return { balances, commands };
}

function normalizeCommand(obj, lineNo) {
  const where = `line ${lineNo}`;
  if (obj.opId === undefined || obj.opId === null) {
    throw new JudgeError(EXIT.USAGE, `${where}: missing opId`);
  }
  const opId = String(obj.opId);
  if (!isFiniteNumber(obj.start) || !isFiniteNumber(obj.end)) {
    throw new JudgeError(EXIT.INVALID_INTERVAL, `${where} (${opId}): start/end must be numbers`);
  }
  if (!isFiniteNumber(obj.amount) || obj.amount < 0) {
    throw new JudgeError(EXIT.USAGE, `${where} (${opId}): amount must be a non-negative number`);
  }
  const depends = obj.depends === undefined ? [] : obj.depends;
  if (!Array.isArray(depends)) {
    throw new JudgeError(EXIT.USAGE, `${where} (${opId}): depends must be an array`);
  }
  return {
    opId,
    session: obj.session === undefined || obj.session === null ? null : String(obj.session),
    start: obj.start,
    end: obj.end,
    action: obj.action,
    account: obj.account === undefined || obj.account === null ? null : String(obj.account),
    amount: obj.amount,
    depends: depends.map(String),
  };
}

// Validate a command list. Order of checks:
//   1. interval validity            -> exit 12
//   2. unknown action / dangling depends / duplicate opId -> exit 14
//   3. depends cycle                -> exit 13
function validateCommands(commands) {
  for (const cmd of commands) {
    if (!isFiniteNumber(cmd.start) || !isFiniteNumber(cmd.end) || cmd.start > cmd.end) {
      throw new JudgeError(EXIT.INVALID_INTERVAL, `${cmd.opId}: invalid interval [${cmd.start}, ${cmd.end}]`);
    }
  }
  const seen = new Set();
  for (const cmd of commands) {
    if (seen.has(cmd.opId)) {
      throw new JudgeError(EXIT.UNKNOWN_COMMAND, `duplicate opId "${cmd.opId}"`);
    }
    seen.add(cmd.opId);
    if (!ACTIONS.has(cmd.action)) {
      throw new JudgeError(EXIT.UNKNOWN_COMMAND, `${cmd.opId}: unknown action "${cmd.action}"`);
    }
    if (cmd.action !== 'DEBIT' && cmd.session === null) {
      throw new JudgeError(EXIT.USAGE, `${cmd.opId}: ${cmd.action} requires a session`);
    }
    if (cmd.account === null) {
      throw new JudgeError(EXIT.USAGE, `${cmd.opId}: missing account`);
    }
  }
  for (const cmd of commands) {
    for (const dep of cmd.depends) {
      if (!seen.has(dep)) {
        throw new JudgeError(EXIT.UNKNOWN_COMMAND, `${cmd.opId}: depends on unknown command "${dep}"`);
      }
    }
  }
  assertAcyclic(commands);
}

// Throws JudgeError(DEPENDS_CYCLE) if the depends graph has a cycle.
function assertAcyclic(commands) {
  const byId = new Map(commands.map((c) => [c.opId, c]));
  const state = new Map(); // 0=unvisited 1=in-stack 2=done
  const stack = [];
  const visit = (id) => {
    state.set(id, 1);
    stack.push(id);
    for (const dep of byId.get(id).depends) {
      if (!byId.has(dep)) continue;
      const s = state.get(dep) || 0;
      if (s === 1) {
        const cycle = stack.slice(stack.indexOf(dep)).concat(dep);
        throw new JudgeError(EXIT.DEPENDS_CYCLE, `depends cycle: ${cycle.join(' -> ')}`);
      }
      if (s === 0) visit(dep);
    }
    stack.pop();
    state.set(id, 2);
  };
  for (const cmd of commands) {
    if (!state.has(cmd.opId)) visit(cmd.opId);
  }
}

// --- Account state machine -------------------------------------------------

function createState(balances) {
  return {
    available: { ...balances },
    frozen: new Map(), // session -> frozen amount
    frozenSessions: new Set(), // sessions with at least one completed FREEZE
  };
}

function cloneState(state) {
  return {
    available: { ...state.available },
    frozen: new Map(state.frozen),
    frozenSessions: new Set(state.frozenSessions),
  };
}

function availableOf(state, account) {
  const value = state.available[account];
  return value === undefined ? 0 : value;
}

// Apply a command to a state (mutates it).
// Returns null on success, or a human-readable violation reason.
function applyCommand(state, cmd) {
  const avail = availableOf(state, cmd.account);
  switch (cmd.action) {
    case 'FREEZE': {
      if (avail < cmd.amount) {
        return `${cmd.opId}: FREEZE ${cmd.amount} exceeds available ${avail} on ${cmd.account}`;
      }
      state.available[cmd.account] = avail - cmd.amount;
      state.frozen.set(cmd.session, (state.frozen.get(cmd.session) || 0) + cmd.amount);
      state.frozenSessions.add(cmd.session);
      return null;
    }
    case 'DEBIT': {
      if (avail < cmd.amount) {
        return `${cmd.opId}: DEBIT ${cmd.amount} exceeds available ${avail} on ${cmd.account}`;
      }
      state.available[cmd.account] = avail - cmd.amount;
      return null;
    }
    case 'RELEASE': {
      const frozen = state.frozen.get(cmd.session) || 0;
      if (frozen < cmd.amount) {
        return `${cmd.opId}: RELEASE ${cmd.amount} exceeds frozen ${frozen} in session ${cmd.session}`;
      }
      state.frozen.set(cmd.session, frozen - cmd.amount);
      state.available[cmd.account] = avail + cmd.amount;
      return null;
    }
    case 'SETTLE': {
      if (!state.frozenSessions.has(cmd.session)) {
        return `${cmd.opId}: SETTLE before any FREEZE in session ${cmd.session}`;
      }
      const frozen = state.frozen.get(cmd.session) || 0;
      if (frozen < cmd.amount) {
        return `${cmd.opId}: SETTLE ${cmd.amount} exceeds frozen ${frozen} in session ${cmd.session}`;
      }
      state.frozen.set(cmd.session, frozen - cmd.amount);
      return null;
    }
    default:
      return `${cmd.opId}: unknown action ${cmd.action}`;
  }
}

module.exports = {
  ACTIONS,
  EXIT,
  JudgeError,
  parseHistory,
  validateCommands,
  assertAcyclic,
  createState,
  cloneState,
  applyCommand,
};
