'use strict';

const DEFAULT_BRANCH = 'main';
const DEFAULT_ACCOUNT = 'default';

class HistError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'HistError';
    this.code = code;
  }
}

function isValidTime(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function parseAsOf(text) {
  if (typeof text !== 'string') {
    throw new HistError('E_TIME', 'as-of point must be a "ts:seq" string');
  }
  const match = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(text.trim());
  if (!match) {
    throw new HistError('E_TIME', `invalid as-of point ${JSON.stringify(text)}, expected "ts:seq"`);
  }
  return { ts: Number(match[1]), seq: Number(match[2]) };
}

function parseLog(text) {
  const events = [];
  const lines = String(text).split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    let obj;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      throw new HistError('E_PARSE', `line ${i + 1}: invalid JSON`);
    }
    if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
      throw new HistError('E_PARSE', `line ${i + 1}: event must be a JSON object`);
    }
    if (!isValidTime(obj.ts) || !isValidTime(obj.seq)) {
      throw new HistError('E_TIME', `line ${i + 1}: event needs numeric ts and seq >= 0`);
    }
    if (typeof obj.op !== 'string' || obj.op.length === 0) {
      throw new HistError('E_PARSE', `line ${i + 1}: event needs a string op`);
    }
    events.push({ ...obj, line: i + 1 });
  }
  return events;
}

function newState() {
  return {
    frozen: false,
    rule: null,
    rules: new Map(),      // ruleId -> { id, group, line }
    members: new Map(),    // group -> Map(account -> joinLine)
    explanation: [],       // array of source line numbers
  };
}

function cloneState(state) {
  return {
    frozen: state.frozen,
    rule: state.rule,
    rules: new Map(state.rules),
    members: new Map([...state.members].map(([g, m]) => [g, new Map(m)])),
    explanation: state.explanation.slice(),
  };
}

// Deny-first merge: any frozen side wins; target keeps priority when both frozen.
function mergeInto(target, source, mergeLine) {
  for (const [id, def] of source.rules) {
    if (!target.rules.has(id)) target.rules.set(id, def);
  }
  for (const [group, members] of source.members) {
    if (!target.members.has(group)) target.members.set(group, new Map());
    const dest = target.members.get(group);
    for (const [account, line] of members) {
      if (!dest.has(account)) dest.set(account, line);
    }
  }
  if (!target.frozen && source.frozen) {
    target.frozen = true;
    target.rule = source.rule;
    target.explanation = [...source.explanation, mergeLine];
  } else if (!target.frozen && !source.frozen && target.explanation.length === 0 && source.explanation.length > 0) {
    target.explanation = [...source.explanation, mergeLine];
  }
}

function branchOf(ev) {
  return ev.branch === undefined ? DEFAULT_BRANCH : ev.branch;
}

function evaluate(events, options = {}) {
  const asOf = typeof options.asOf === 'string' ? parseAsOf(options.asOf) : options.asOf;
  if (!asOf || !isValidTime(asOf.ts) || !isValidTime(asOf.seq)) {
    throw new HistError('E_TIME', 'invalid as-of point, expected { ts, seq } >= 0');
  }
  const queryBranch = options.branch === undefined ? DEFAULT_BRANCH : options.branch;
  const account = options.account === undefined ? DEFAULT_ACCOUNT : options.account;

  const eligible = events
    .filter((e) => isValidTime(e.ts) && isValidTime(e.seq))
    .filter((e) => e.ts < asOf.ts || (e.ts === asOf.ts && e.seq <= asOf.seq))
    .slice()
    .sort((a, b) => (a.ts - b.ts) || (a.seq - b.seq) || ((a.line || 0) - (b.line || 0)));

  const states = new Map([[DEFAULT_BRANCH, newState()]]);
  const requireBranch = (name, line) => {
    const state = states.get(name);
    if (!state) {
      throw new HistError('E_FORK', `line ${line}: unknown branch ${JSON.stringify(name)}`);
    }
    return state;
  };

  for (const ev of eligible) {
    switch (ev.op) {
      case 'rule': {
        if (typeof ev.id !== 'string' || ev.id.length === 0) {
          throw new HistError('E_PARSE', `line ${ev.line}: rule op needs a string id`);
        }
        const state = requireBranch(branchOf(ev), ev.line);
        state.rules.set(ev.id, { id: ev.id, group: ev.group === undefined ? null : ev.group, line: ev.line });
        break;
      }
      case 'revoke': {
        const state = requireBranch(branchOf(ev), ev.line);
        state.rules.delete(ev.rule);
        if (state.frozen && state.rule === ev.rule) {
          state.frozen = false;
          state.rule = null;
          state.explanation = state.explanation.length > 0 ? [...state.explanation, ev.line] : [];
        }
        break;
      }
      case 'join': {
        if (typeof ev.group !== 'string' || ev.group.length === 0) {
          throw new HistError('E_PARSE', `line ${ev.line}: join op needs a string group`);
        }
        const state = requireBranch(branchOf(ev), ev.line);
        const member = ev.account === undefined ? DEFAULT_ACCOUNT : ev.account;
        if (!state.members.has(ev.group)) state.members.set(ev.group, new Map());
        const members = state.members.get(ev.group);
        if (!members.has(member)) members.set(member, ev.line);
        break;
      }
      case 'trigger': {
        const state = requireBranch(branchOf(ev), ev.line);
        const evAccount = ev.account === undefined ? DEFAULT_ACCOUNT : ev.account;
        if (evAccount !== account) break;
        if (state.frozen) break;
        const def = state.rules.get(ev.rule);
        if (!def) break;
        if (def.group !== null) {
          const members = state.members.get(def.group);
          if (!members || !members.has(account)) break;
        }
        state.frozen = true;
        state.rule = def.id;
        const explanation = [def.line];
        if (def.group !== null) explanation.push(state.members.get(def.group).get(account));
        explanation.push(ev.line);
        state.explanation = explanation;
        break;
      }
      case 'fork': {
        const parent = requireBranch(branchOf(ev), ev.line);
        if (!Array.isArray(ev.branches) || ev.branches.length === 0) {
          throw new HistError('E_FORK', `line ${ev.line}: fork needs a non-empty branches array`);
        }
        for (const name of ev.branches) {
          if (typeof name !== 'string' || name.length === 0) {
            throw new HistError('E_FORK', `line ${ev.line}: fork branch names must be non-empty strings`);
          }
          if (states.has(name)) {
            throw new HistError('E_FORK', `line ${ev.line}: branch ${JSON.stringify(name)} already exists`);
          }
        }
        for (const name of ev.branches) states.set(name, cloneState(parent));
        break;
      }
      case 'merge': {
        const targetName = branchOf(ev);
        const target = requireBranch(targetName, ev.line);
        if (!Array.isArray(ev.sources) || ev.sources.length === 0) {
          throw new HistError('E_FORK', `line ${ev.line}: merge needs a non-empty sources array`);
        }
        for (const sourceName of ev.sources) {
          if (sourceName === targetName) {
            throw new HistError('E_FORK', `line ${ev.line}: cannot merge a branch into itself`);
          }
          const source = requireBranch(sourceName, ev.line);
          mergeInto(target, source, ev.line);
        }
        break;
      }
      default:
        throw new HistError('E_PARSE', `line ${ev.line}: unknown op ${JSON.stringify(ev.op)}`);
    }
  }

  const state = states.get(queryBranch);
  if (!state) {
    throw new HistError('E_FORK', `unknown branch ${JSON.stringify(queryBranch)}`);
  }

  const byLine = new Map(events.map((e) => [e.line, e]));
  const explanation = state.explanation
    .map((line) => byLine.get(line))
    .filter(Boolean)
    .map((ev) => {
      const ref = { line: ev.line, ts: ev.ts, seq: ev.seq, op: ev.op };
      for (const key of ['id', 'rule', 'account', 'group', 'branch', 'branches', 'sources']) {
        if (ev[key] !== undefined) ref[key] = ev[key];
      }
      return ref;
    });

  return {
    asOf: `${asOf.ts}:${asOf.seq}`,
    branch: queryBranch,
    account,
    frozen: state.frozen,
    rule: state.rule,
    explanation,
  };
}

module.exports = {
  DEFAULT_BRANCH,
  DEFAULT_ACCOUNT,
  HistError,
  parseAsOf,
  parseLog,
  evaluate,
};
