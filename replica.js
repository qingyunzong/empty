'use strict';

const crypto = require('node:crypto');

const CONFIG_TYPES = new Set(['add-member', 'remove-member']);
const DATA_TYPES = new Set(['freeze', 'release']);

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
}

function hashEvent(event) {
  const rest = {};
  for (const [key, value] of Object.entries(event)) {
    if (key !== 'hash') rest[key] = value;
  }
  return crypto.createHash('sha256').update(canonical(rest)).digest('hex');
}

function createState() {
  return {
    epoch: 0,
    accounts: {},
    members: {},
    events: {},
    byHash: {},
    applied: [],
    rejected: [],
    releases: {},
    configTip: null,
    memberTips: {},
  };
}

function setAccountLimit(state, accountId, limit) {
  if (typeof limit !== 'number' || !Number.isFinite(limit) || limit < 0) {
    return { error: 'invalid-amount' };
  }
  const account = state.accounts[accountId] || (state.accounts[accountId] = { limit: 0, frozen: 0 });
  account.limit = limit;
  return { ok: true };
}

function getAccount(state, accountId) {
  const account = state.accounts[accountId];
  if (!account) return null;
  return {
    account: accountId,
    limit: account.limit,
    frozen: account.frozen,
    available: account.limit - account.frozen,
  };
}

function makeFreeze(state, { id, account, amount, memberId }) {
  const event = {
    id,
    type: 'freeze',
    account,
    amount,
    memberId,
    epoch: state.epoch,
    prev: state.memberTips[memberId] ?? null,
  };
  event.hash = hashEvent(event);
  return event;
}

function makeRelease(state, { id, memberId, target }) {
  const event = {
    id,
    type: 'release',
    memberId,
    target,
    epoch: state.epoch,
    prev: state.memberTips[memberId] ?? null,
  };
  event.hash = hashEvent(event);
  return event;
}

function makeAddMember(state, { id, memberId }) {
  const event = {
    id,
    type: 'add-member',
    memberId,
    epoch: state.epoch + 1,
    prev: state.configTip,
  };
  event.hash = hashEvent(event);
  return event;
}

function makeRemoveMember(state, { id, memberId, frontier }) {
  const event = {
    id,
    type: 'remove-member',
    memberId,
    epoch: state.epoch + 1,
    prev: state.configTip,
    frontier: frontier !== undefined ? frontier : (state.memberTips[memberId] ?? null),
  };
  event.hash = hashEvent(event);
  return event;
}

function isCoveredByFrontier(state, memberId, hash) {
  const member = state.members[memberId];
  if (!member || member.status !== 'removed') return false;
  let cursor = member.frontier;
  const seen = new Set();
  while (cursor && !seen.has(cursor)) {
    if (cursor === hash) return true;
    seen.add(cursor);
    const id = state.byHash[cursor];
    const event = id ? state.events[id] : null;
    cursor = event ? event.prev : null;
  }
  return false;
}

function storeEvent(state, event) {
  state.events[event.id] = event;
  state.byHash[event.hash] = event.id;
}

function applyAddMember(state, event) {
  if (event.prev !== state.configTip) return { error: 'config-gap' };
  const member = state.members[event.memberId];
  if (member) return { error: member.status === 'removed' ? 'member-removed' : 'member-exists' };
  state.members[event.memberId] = { status: 'active', joinEpoch: event.epoch };
  state.epoch = event.epoch;
  state.configTip = event.hash;
  return { ok: true };
}

function applyRemoveMember(state, event) {
  if (event.prev !== state.configTip) return { error: 'config-gap' };
  const member = state.members[event.memberId];
  if (!member) return { error: 'unknown-member' };
  if (member.status === 'removed') return { error: 'member-removed' };
  const tip = state.memberTips[event.memberId] ?? null;
  const frontier = event.frontier ?? null;
  if (frontier !== tip) return { error: 'remove-incomplete' };
  member.status = 'removed';
  member.removeEpoch = event.epoch;
  member.frontier = frontier;
  state.epoch = event.epoch;
  state.configTip = event.hash;
  return { ok: true };
}

function checkAuthor(state, event) {
  const member = state.members[event.memberId];
  if (!member) return { error: 'unknown-member' };
  if (typeof event.epoch === 'number' && event.epoch > state.epoch) return { error: 'epoch-unknown' };
  if (member.status === 'removed' && !isCoveredByFrontier(state, event.memberId, event.hash)) {
    return { error: 'stale-member' };
  }
  const expectedPrev = state.memberTips[event.memberId] ?? null;
  if ((event.prev ?? null) !== expectedPrev) return { error: 'missing-dependency' };
  return { ok: true };
}

function applyFreeze(state, event) {
  if (typeof event.amount !== 'number' || !Number.isFinite(event.amount) || event.amount <= 0) {
    return { error: 'invalid-amount' };
  }
  const author = checkAuthor(state, event);
  if (author.error) return author;
  const account = state.accounts[event.account];
  if (!account) return { error: 'unknown-account' };
  if (account.frozen + event.amount > account.limit) return { error: 'limit-exceeded' };
  account.frozen += event.amount;
  state.memberTips[event.memberId] = event.hash;
  return { ok: true };
}

function applyRelease(state, event) {
  const author = checkAuthor(state, event);
  if (author.error) return author;
  const target = state.events[event.target];
  if (!target || target.type !== 'freeze' || !state.applied.includes(event.target)) {
    return { error: 'unknown-freeze' };
  }
  if (state.releases[event.target]) return { error: 'already-released' };
  const account = state.accounts[target.account];
  account.frozen -= target.amount;
  state.releases[event.target] = event.id;
  state.memberTips[event.memberId] = event.hash;
  return { ok: true };
}

function applyEvent(state, event) {
  if (!event || typeof event !== 'object' || typeof event.id !== 'string') {
    return { error: 'invalid-event' };
  }
  const existing = state.events[event.id];
  if (existing) {
    if (existing.hash === event.hash) return { ok: true, duplicate: true };
    return { error: 'duplicate-id' };
  }
  if (event.hash !== hashEvent(event)) return { error: 'bad-hash' };
  let result;
  switch (event.type) {
    case 'add-member':
      result = applyAddMember(state, event);
      break;
    case 'remove-member':
      result = applyRemoveMember(state, event);
      break;
    case 'freeze':
      result = applyFreeze(state, event);
      break;
    case 'release':
      result = applyRelease(state, event);
      break;
    default:
      return { error: 'invalid-event' };
  }
  storeEvent(state, event);
  if (result.error) {
    state.rejected.push({ id: event.id, error: result.error });
    return result;
  }
  state.applied.push(event.id);
  return { ok: true };
}

function diffStates(state, other) {
  const missing = { missingFreezes: [], missingReleases: [], missingMembers: [] };
  for (const event of Object.values((other && other.events) || {})) {
    if (state.events[event.id]) continue;
    if (event.type === 'freeze') missing.missingFreezes.push(event.id);
    else if (event.type === 'release') missing.missingReleases.push(event.id);
    else if (CONFIG_TYPES.has(event.type)) missing.missingMembers.push(event.id);
  }
  missing.missingFreezes.sort();
  missing.missingReleases.sort();
  missing.missingMembers.sort();
  return missing;
}

function mergeStates(state, other) {
  const result = { merged: [], rejected: [] };
  if (!other || typeof other !== 'object') return result;
  for (const [id, account] of Object.entries(other.accounts || {})) {
    if (!state.accounts[id]) state.accounts[id] = { limit: account.limit, frozen: 0 };
  }
  const incoming = Object.values(other.events || {}).filter((event) => {
    const existing = state.events[event.id];
    return !existing || existing.hash !== event.hash;
  });
  const record = (res, event) => {
    if (res.error) result.rejected.push({ id: event.id, error: res.error });
    else if (!res.duplicate) result.merged.push(event.id);
  };
  const config = incoming
    .filter((event) => CONFIG_TYPES.has(event.type))
    .sort((a, b) => a.epoch - b.epoch);
  for (const event of config) record(applyEvent(state, event), event);

  let pending = incoming.filter((event) => DATA_TYPES.has(event.type));
  let progress = true;
  while (pending.length > 0 && progress) {
    progress = false;
    const appliedHashes = new Set(state.applied.map((id) => state.events[id].hash));
    const waiting = [];
    for (const event of pending) {
      if (event.prev == null || appliedHashes.has(event.prev)) {
        record(applyEvent(state, event), event);
        progress = true;
      } else {
        waiting.push(event);
      }
    }
    pending = waiting;
  }
  for (const event of pending) record(applyEvent(state, event), event);
  return result;
}

module.exports = {
  CONFIG_TYPES,
  DATA_TYPES,
  canonical,
  hashEvent,
  createState,
  setAccountLimit,
  getAccount,
  makeFreeze,
  makeRelease,
  makeAddMember,
  makeRemoveMember,
  isCoveredByFrontier,
  applyEvent,
  diffStates,
  mergeStates,
};
