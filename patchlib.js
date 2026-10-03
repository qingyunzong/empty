'use strict';
// 风控额度补丁库：diff / apply / revert
// 状态形状：{ accounts: { [id]: { limit, used, holds: [{ hid, amount, tag }] } } }
// 可用额 = limit - used - sum(holds)

const crypto = require('node:crypto');

const OP_TYPES = new Set(['setLimit', 'addHold', 'removeHold', 'changeTag']);

const EXIT = {
  OK: 0,
  USAGE: 2,
  HASH_MISMATCH: 6,
  INSUFFICIENT_LIMIT: 7,
  UNKNOWN_OP: 8,
};

class PatchError extends Error {
  constructor(message, exitCode, opIndex = null) {
    super(message);
    this.name = 'PatchError';
    this.exitCode = exitCode;
    this.opIndex = opIndex;
  }
}

function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object') {
    return '{' + Object.keys(value).sort()
      .map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  }
  return JSON.stringify(value);
}

function sha256hex(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function compareHid(a, b) {
  const sa = String(a);
  const sb = String(b);
  if (sa < sb) return -1;
  if (sa > sb) return 1;
  return 0;
}

// 规范化：每个账户的 holds 按 hid 排序。holds 在语义上是以 hid 为键的集合，
// 规范化保证哈希与数组顺序无关，apply/revert 输出也因此确定。
function normalizeState(state) {
  const clone = deepClone(state);
  for (const id of Object.keys(clone.accounts || {})) {
    const account = clone.accounts[id];
    if (Array.isArray(account.holds)) {
      account.holds = account.holds.slice().sort((x, y) => compareHid(x.hid, y.hid));
    }
  }
  return clone;
}

function hashState(state) {
  return sha256hex(canonical(normalizeState(state)));
}

function sumHolds(account) {
  return account.holds.reduce((acc, h) => acc + h.amount, 0);
}

function available(account) {
  return account.limit - account.used - sumHolds(account);
}

function byHid(holds) {
  const map = new Map();
  for (const h of holds) map.set(h.hid, h);
  return map;
}

function sortByHid(list) {
  return list.slice().sort((a, b) => compareHid(a.hid, b.hid));
}

// 生成结构化差异。op 顺序保证中间态合法：先释放冻结，再调额度，再改标签，最后新增冻结。
function diffStates(base, target) {
  const baseIds = Object.keys(base.accounts || {}).sort();
  const targetIds = Object.keys(target.accounts || {}).sort();
  if (canonical(baseIds) !== canonical(targetIds)) {
    throw new PatchError('account id sets differ between base and target', EXIT.USAGE);
  }
  const ops = [];
  for (const id of baseIds) {
    const b = base.accounts[id];
    const t = target.accounts[id];
    if (b.used !== t.used) {
      throw new PatchError(`used differs for account ${id}; not representable as patch ops`, EXIT.USAGE);
    }
    const bHolds = byHid(b.holds);
    const tHolds = byHid(t.holds);

    const removed = [];
    for (const [hid, h] of bHolds) {
      const th = tHolds.get(hid);
      if (!th || th.amount !== h.amount) removed.push(h);
    }
    for (const h of sortByHid(removed)) {
      ops.push({ op: 'removeHold', account: id, hold: deepClone(h) });
    }

    if (b.limit !== t.limit) {
      ops.push({ op: 'setLimit', account: id, limit: t.limit, prevLimit: b.limit });
    }

    const tagChanges = [];
    for (const [hid, h] of bHolds) {
      const th = tHolds.get(hid);
      if (th && th.amount === h.amount && th.tag !== h.tag) {
        tagChanges.push({ hid, tag: th.tag, prevTag: h.tag });
      }
    }
    for (const c of sortByHid(tagChanges)) {
      ops.push({ op: 'changeTag', account: id, hid: c.hid, tag: c.tag, prevTag: c.prevTag });
    }

    const added = [];
    for (const [hid, h] of tHolds) {
      const bh = bHolds.get(hid);
      if (!bh || bh.amount !== h.amount) added.push(h);
    }
    for (const h of sortByHid(added)) {
      ops.push({ op: 'addHold', account: id, hold: deepClone(h) });
    }
  }
  return ops;
}

function makePatch(base, target) {
  const body = {
    version: 1,
    fromHash: hashState(base),
    toHash: hashState(target),
    ops: diffStates(base, target),
  };
  return Object.assign({}, body, { sha256: sha256hex(canonical(body)) });
}

function checkPatchIntegrity(patch) {
  if (!patch || typeof patch !== 'object') {
    throw new PatchError('patch is not an object', EXIT.HASH_MISMATCH);
  }
  const rest = Object.assign({}, patch);
  const digest = rest.sha256;
  delete rest.sha256;
  if (typeof digest !== 'string' || sha256hex(canonical(rest)) !== digest) {
    throw new PatchError('patch sha256 mismatch (corrupted patch)', EXIT.HASH_MISMATCH);
  }
}

function applyOp(state, op, opIndex) {
  if (!op || !OP_TYPES.has(op.op)) {
    throw new PatchError(`unknown op: ${op && op.op}`, EXIT.UNKNOWN_OP, opIndex);
  }
  const account = state.accounts[op.account];
  if (!account) {
    throw new PatchError(`unknown account: ${op.account}`, EXIT.INSUFFICIENT_LIMIT, opIndex);
  }
  switch (op.op) {
    case 'setLimit': {
      if (typeof op.limit !== 'number' || !(op.limit >= 0)) {
        throw new PatchError(`invalid limit: ${op.limit}`, EXIT.INSUFFICIENT_LIMIT, opIndex);
      }
      if (op.limit < account.used + sumHolds(account)) {
        throw new PatchError(
          `setLimit ${op.limit} < used+holds ${account.used + sumHolds(account)}`,
          EXIT.INSUFFICIENT_LIMIT, opIndex);
      }
      account.limit = op.limit;
      break;
    }
    case 'addHold': {
      const h = op.hold;
      if (!h || typeof h.amount !== 'number' || !(h.amount > 0)) {
        throw new PatchError('addHold amount must be > 0', EXIT.INSUFFICIENT_LIMIT, opIndex);
      }
      if (account.holds.some((x) => x.hid === h.hid)) {
        throw new PatchError(`duplicate hid: ${h.hid}`, EXIT.INSUFFICIENT_LIMIT, opIndex);
      }
      if (available(account) - h.amount < 0) {
        throw new PatchError(
          `addHold ${h.amount} exceeds available ${available(account)}`,
          EXIT.INSUFFICIENT_LIMIT, opIndex);
      }
      account.holds.push({ hid: h.hid, amount: h.amount, tag: h.tag === undefined ? null : h.tag });
      break;
    }
    case 'removeHold': {
      const hid = op.hold && op.hold.hid;
      const idx = account.holds.findIndex((x) => x.hid === hid);
      if (idx < 0) {
        throw new PatchError(`hold not found: ${hid}`, EXIT.INSUFFICIENT_LIMIT, opIndex);
      }
      account.holds.splice(idx, 1);
      break;
    }
    case 'changeTag': {
      const hold = account.holds.find((x) => x.hid === op.hid);
      if (!hold) {
        throw new PatchError(`hold not found: ${op.hid}`, EXIT.INSUFFICIENT_LIMIT, opIndex);
      }
      hold.tag = op.tag;
      break;
    }
    default:
      throw new PatchError(`unknown op: ${op.op}`, EXIT.UNKNOWN_OP, opIndex);
  }
}

// 应用补丁。失败时抛 PatchError，调用方持有原状态不变（整体原子）。
function applyPatch(state, patch) {
  checkPatchIntegrity(patch);
  const currentHash = hashState(state);
  if (currentHash === patch.toHash) {
    return { state: deepClone(state), appliedOps: 0, alreadyApplied: true };
  }
  if (currentHash !== patch.fromHash) {
    throw new PatchError(
      `state hash ${currentHash.slice(0, 12)} != patch fromHash ${String(patch.fromHash).slice(0, 12)}`,
      EXIT.HASH_MISMATCH);
  }
  const next = deepClone(state);
  for (let i = 0; i < patch.ops.length; i += 1) {
    applyOp(next, patch.ops[i], i);
  }
  const normalized = normalizeState(next);
  const resultHash = hashState(normalized);
  if (resultHash !== patch.toHash) {
    throw new PatchError(
      `result hash ${resultHash.slice(0, 12)} != patch toHash ${String(patch.toHash).slice(0, 12)}`,
      EXIT.HASH_MISMATCH);
  }
  return { state: normalized, appliedOps: patch.ops.length, alreadyApplied: false };
}

function invertOp(op) {
  switch (op.op) {
    case 'setLimit':
      return { op: 'setLimit', account: op.account, limit: op.prevLimit, prevLimit: op.limit };
    case 'addHold':
      return { op: 'removeHold', account: op.account, hold: deepClone(op.hold) };
    case 'removeHold':
      return { op: 'addHold', account: op.account, hold: deepClone(op.hold) };
    case 'changeTag':
      return { op: 'changeTag', account: op.account, hid: op.hid, tag: op.prevTag, prevTag: op.tag };
    default:
      throw new PatchError(`unknown op: ${op && op.op}`, EXIT.UNKNOWN_OP);
  }
}

// 回滚补丁。仅当当前状态哈希等于 patch.toHash 时允许。
function revertPatch(state, patch) {
  checkPatchIntegrity(patch);
  const currentHash = hashState(state);
  if (currentHash !== patch.toHash) {
    throw new PatchError(
      `state hash ${currentHash.slice(0, 12)} != patch toHash ${String(patch.toHash).slice(0, 12)}; refuse revert`,
      EXIT.HASH_MISMATCH);
  }
  const next = deepClone(state);
  for (let i = patch.ops.length - 1; i >= 0; i -= 1) {
    applyOp(next, invertOp(patch.ops[i]), i);
  }
  const normalized = normalizeState(next);
  const resultHash = hashState(normalized);
  if (resultHash !== patch.fromHash) {
    throw new PatchError(
      `revert result hash ${resultHash.slice(0, 12)} != patch fromHash ${String(patch.fromHash).slice(0, 12)}`,
      EXIT.HASH_MISMATCH);
  }
  return { state: normalized, appliedOps: patch.ops.length };
}

module.exports = {
  OP_TYPES,
  EXIT,
  PatchError,
  canonical,
  normalizeState,
  hashState,
  available,
  diffStates,
  makePatch,
  applyPatch,
  revertPatch,
};
