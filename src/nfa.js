'use strict';

const crypto = require('node:crypto');
const { CODES, ComplianceError } = require('./errors');

const MAX_DFA_STATES = 200;

function sha256Hex(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function isValidatedNfa(spec) {
  return spec !== null && typeof spec === 'object' && spec.roleTrans instanceof Map;
}

function validateNfa(spec) {
  if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) {
    throw new ComplianceError(CODES.INVALID_NFA, 'NFA spec must be a JSON object');
  }
  const { states, start, accept, transitions } = spec;
  if (!Array.isArray(states) || states.length === 0 || !states.every((s) => typeof s === 'string')) {
    throw new ComplianceError(CODES.INVALID_NFA, 'NFA "states" must be a non-empty array of strings');
  }
  if (new Set(states).size !== states.length) {
    throw new ComplianceError(CODES.INVALID_NFA, 'NFA "states" contains duplicates');
  }
  const stateSet = new Set(states);
  if (typeof start !== 'string' || !stateSet.has(start)) {
    throw new ComplianceError(CODES.INVALID_NFA, 'NFA "start" must name a declared state');
  }
  if (!Array.isArray(accept) || !accept.every((s) => stateSet.has(s))) {
    throw new ComplianceError(CODES.INVALID_NFA, 'NFA "accept" must be an array of declared states');
  }
  if (!Array.isArray(transitions)) {
    throw new ComplianceError(CODES.INVALID_NFA, 'NFA "transitions" must be an array');
  }
  const roleTrans = new Map();
  const epsTrans = new Map();
  const roles = new Set();
  transitions.forEach((t, index) => {
    if (t === null || typeof t !== 'object' || Array.isArray(t)) {
      throw new ComplianceError(CODES.INVALID_NFA, `transition ${index} must be an object`);
    }
    const { from, to } = t;
    if (!stateSet.has(from) || !stateSet.has(to)) {
      throw new ComplianceError(CODES.INVALID_NFA, `transition ${index} references an unknown state`);
    }
    const isEpsilon = t.epsilon === true || t.role === null || t.role === undefined;
    if (isEpsilon) {
      if (!epsTrans.has(from)) epsTrans.set(from, new Set());
      epsTrans.get(from).add(to);
      return;
    }
    if (typeof t.role !== 'string' || t.role.length === 0) {
      throw new ComplianceError(CODES.INVALID_NFA, `transition ${index} has an invalid role`);
    }
    if (!roleTrans.has(from)) roleTrans.set(from, new Map());
    const byRole = roleTrans.get(from);
    if (!byRole.has(t.role)) byRole.set(t.role, new Set());
    byRole.get(t.role).add(to);
    roles.add(t.role);
  });
  if (roles.size === 0) {
    throw new ComplianceError(
      CODES.NFA_EPSILON_ONLY,
      'NFA has no role-labelled transitions (epsilon-only flows are not supported)'
    );
  }
  if (spec.roles !== undefined) {
    if (!Array.isArray(spec.roles) || !spec.roles.every((r) => typeof r === 'string' && r.length > 0)) {
      throw new ComplianceError(CODES.INVALID_NFA, 'NFA "roles" must be an array of non-empty strings');
    }
    for (const role of spec.roles) roles.add(role);
  }
  return {
    states: states.slice(),
    start,
    accept: new Set(accept),
    roles: [...roles].sort(),
    roleTrans,
    epsTrans,
  };
}

function epsilonClosure(nfa, stateSet) {
  const closure = new Set(stateSet);
  const stack = [...stateSet];
  while (stack.length > 0) {
    const state = stack.pop();
    const targets = nfa.epsTrans.get(state);
    if (!targets) continue;
    for (const target of targets) {
      if (!closure.has(target)) {
        closure.add(target);
        stack.push(target);
      }
    }
  }
  return closure;
}

function moveRole(nfa, stateSet, role) {
  const out = new Set();
  for (const state of stateSet) {
    const byRole = nfa.roleTrans.get(state);
    if (!byRole) continue;
    const targets = byRole.get(role);
    if (!targets) continue;
    for (const target of targets) out.add(target);
  }
  return out;
}

const setKey = (set) => [...set].sort().join('');

function subsetConstruction(nfa) {
  const startSet = epsilonClosure(nfa, new Set([nfa.start]));
  const states = [];
  const keyToName = new Map();
  const trans = new Map();
  const accept = new Set();
  const queue = [];
  const register = (set) => {
    const key = setKey(set);
    if (keyToName.has(key)) return keyToName.get(key);
    if (states.length >= MAX_DFA_STATES) {
      throw new ComplianceError(CODES.STATE_LIMIT, `subset construction exceeded ${MAX_DFA_STATES} DFA states`);
    }
    const name = `d${states.length}`;
    states.push(name);
    keyToName.set(key, name);
    trans.set(name, new Map());
    for (const s of set) {
      if (nfa.accept.has(s)) {
        accept.add(name);
        break;
      }
    }
    queue.push([name, set]);
    return name;
  };
  const startName = register(startSet);
  while (queue.length > 0) {
    const [name, set] = queue.shift();
    for (const role of nfa.roles) {
      const moved = moveRole(nfa, set, role);
      if (moved.size === 0) continue;
      const targetName = register(epsilonClosure(nfa, moved));
      trans.get(name).set(role, targetName);
    }
  }
  return { states, start: startName, accept, trans, roles: nfa.roles.slice() };
}

function minimizeDfa(dfa) {
  const blocks = [];
  const acceptBlock = dfa.states.filter((s) => dfa.accept.has(s));
  const nonAcceptBlock = dfa.states.filter((s) => !dfa.accept.has(s));
  if (acceptBlock.length > 0) blocks.push(acceptBlock);
  if (nonAcceptBlock.length > 0) blocks.push(nonAcceptBlock);
  const blockOf = new Map();
  const reindex = () => {
    blocks.forEach((block, index) => block.forEach((s) => blockOf.set(s, index)));
  };
  reindex();
  let changed = true;
  while (changed) {
    changed = false;
    const nextBlocks = [];
    for (const block of blocks) {
      const groups = new Map();
      for (const state of block) {
        const row = dfa.trans.get(state);
        const signature = dfa.roles
          .map((role) => {
            const target = row.get(role);
            return target === undefined ? -1 : blockOf.get(target);
          })
          .join(',');
        if (!groups.has(signature)) groups.set(signature, []);
        groups.get(signature).push(state);
      }
      if (groups.size > 1) changed = true;
      for (const group of groups.values()) nextBlocks.push(group);
    }
    blocks.length = 0;
    blocks.push(...nextBlocks);
    reindex();
  }
  // Canonical BFS renaming of the quotient automaton, independent of input names.
  const startBlock = blockOf.get(dfa.start);
  const nameOf = new Map([[startBlock, 'm0']]);
  const states = [];
  const trans = new Map();
  const accept = new Set();
  const queue = [startBlock];
  const processed = new Set();
  while (queue.length > 0) {
    const blockIndex = queue.shift();
    if (processed.has(blockIndex)) continue;
    processed.add(blockIndex);
    const name = nameOf.get(blockIndex);
    states.push(name);
    const rep = blocks[blockIndex][0];
    if (dfa.accept.has(rep)) accept.add(name);
    const row = new Map();
    const repRow = dfa.trans.get(rep);
    for (const role of dfa.roles) {
      const target = repRow.get(role);
      if (target === undefined) continue;
      const targetBlock = blockOf.get(target);
      if (!nameOf.has(targetBlock)) nameOf.set(targetBlock, `m${nameOf.size}`);
      row.set(role, nameOf.get(targetBlock));
      queue.push(targetBlock);
    }
    trans.set(name, row);
  }
  return { states, start: 'm0', accept, trans, roles: dfa.roles.slice() };
}

function canonicalDfaHash(dfa) {
  const transitions = [];
  for (const from of [...dfa.trans.keys()].sort()) {
    const row = dfa.trans.get(from);
    for (const role of [...row.keys()].sort()) {
      transitions.push([from, role, row.get(role)]);
    }
  }
  const doc = {
    states: [...dfa.states].sort(),
    start: dfa.start,
    accept: [...dfa.accept].sort(),
    roles: [...dfa.roles].sort(),
    transitions,
  };
  return `sha256:${sha256Hex(JSON.stringify(doc))}`;
}

function compileNfa(spec) {
  const nfa = validateNfa(spec);
  const subset = subsetConstruction(nfa);
  const dfa = minimizeDfa(subset);
  dfa.hash = canonicalDfaHash(dfa);
  dfa.stateSet = new Set(dfa.states);
  return dfa;
}

function enabledRoles(dfa, state) {
  const row = dfa.trans.get(state);
  if (!row) return [];
  return [...row.keys()].sort();
}

// Reference nondeterministic simulator used to cross-check the compiled DFA.
function simulateNfa(specOrNfa, roles) {
  const nfa = isValidatedNfa(specOrNfa) ? specOrNfa : validateNfa(specOrNfa);
  let current = epsilonClosure(nfa, new Set([nfa.start]));
  let consumed = 0;
  for (const role of roles) {
    const next = epsilonClosure(nfa, moveRole(nfa, current, role));
    if (next.size === 0) break;
    current = next;
    consumed += 1;
  }
  const accepted = consumed === roles.length && [...current].some((s) => nfa.accept.has(s));
  const continuations = new Set();
  for (const state of current) {
    const byRole = nfa.roleTrans.get(state);
    if (byRole) for (const role of byRole.keys()) continuations.add(role);
  }
  return { consumed, accepted, continuations: [...continuations].sort() };
}

module.exports = {
  MAX_DFA_STATES,
  validateNfa,
  epsilonClosure,
  moveRole,
  subsetConstruction,
  minimizeDfa,
  canonicalDfaHash,
  compileNfa,
  enabledRoles,
  simulateNfa,
};
