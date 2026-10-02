import { createHash } from 'node:crypto';

export class RebaseError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RebaseError';
    this.code = code;
  }
}

export function canonicalize(value) {
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalize).join(',') + ']';
  }
  if (value !== null && typeof value === 'object') {
    return '{' + Object.keys(value).sort()
      .map((k) => JSON.stringify(k) + ':' + canonicalize(value[k]))
      .join(',') + '}';
  }
  return JSON.stringify(value);
}

export function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

export function snapshotHash(state) {
  return sha256(canonicalize(state));
}

export function computeCommitHash({ parent, number, patch, context }) {
  return sha256(canonicalize({ parent: parent ?? null, number, patch, context }));
}

function valuesEqual(a, b) {
  return canonicalize(a === undefined ? null : a) === canonicalize(b === undefined ? null : b);
}

export class ConflictError extends Error {
  constructor(message, op) {
    super(message);
    this.name = 'ConflictError';
    this.op = op;
  }
}

export function applyOp(state, op) {
  switch (op.op) {
    case 'set': {
      if (Object.hasOwn(op, 'old')) {
        const current = Object.hasOwn(state, op.path) ? state[op.path] : undefined;
        if (!valuesEqual(current, op.old)) {
          throw new ConflictError(
            `set ${op.path}: expected old value ${canonicalize(op.old ?? null)} but found ${canonicalize(current ?? null)}`, op);
        }
      }
      state[op.path] = op.value;
      return;
    }
    case 'delete': {
      if (!Object.hasOwn(state, op.path)) {
        throw new ConflictError(`delete ${op.path}: path does not exist`, op);
      }
      if (Object.hasOwn(op, 'old') && !valuesEqual(state[op.path], op.old)) {
        throw new ConflictError(
          `delete ${op.path}: expected old value ${canonicalize(op.old)} but found ${canonicalize(state[op.path])}`, op);
      }
      delete state[op.path];
      return;
    }
    case 'move': {
      if (!Object.hasOwn(state, op.from)) {
        throw new ConflictError(`move ${op.from} -> ${op.to}: source record was moved or removed`, op);
      }
      if (Object.hasOwn(state, op.to)) {
        throw new ConflictError(`move ${op.from} -> ${op.to}: destination already exists`, op);
      }
      state[op.to] = state[op.from];
      delete state[op.from];
      return;
    }
    default:
      throw new RebaseError('INVALID_OP', `unknown op: ${String(op.op)}`);
  }
}

export function applyPatch(state, patch) {
  for (const op of patch) applyOp(state, op);
  return state;
}

function cloneState(state) {
  return JSON.parse(JSON.stringify(state));
}

// Validates the commit list and returns a Map of hash -> normalized commit.
export function validateHistory(commits) {
  if (!Array.isArray(commits)) {
    throw new RebaseError('INVALID_HISTORY', 'commits must be an array');
  }
  const byHash = new Map();
  const byNumber = new Map();
  for (const raw of commits) {
    const commit = {
      hash: raw.hash ?? null,
      parent: raw.parent ?? null,
      number: raw.number,
      patch: raw.patch ?? [],
      context: raw.context ?? null,
    };
    if (typeof commit.number !== 'number' || !Number.isInteger(commit.number)) {
      throw new RebaseError('INVALID_HISTORY', `commit has invalid experiment number: ${String(raw.number)}`);
    }
    if (byNumber.has(commit.number)) {
      throw new RebaseError('DUPLICATE_NUMBER', `duplicate experiment number: ${commit.number}`);
    }
    if (commit.hash === null) {
      if (commit.context === null) {
        throw new RebaseError('INVALID_HISTORY', `commit ${commit.number} lacks both hash and context`);
      }
      commit.hash = computeCommitHash(commit);
    }
    if (byHash.has(commit.hash)) {
      throw new RebaseError('DUPLICATE_HASH', `duplicate commit hash: ${commit.hash}`);
    }
    byNumber.set(commit.number, commit);
    byHash.set(commit.hash, commit);
  }
  for (const commit of byHash.values()) {
    if (commit.parent !== null && !byHash.has(commit.parent)) {
      throw new RebaseError('BROKEN_PARENT',
        `commit ${commit.number} (${commit.hash}) references missing parent ${commit.parent}`);
    }
  }
  for (const commit of byHash.values()) {
    const seen = new Set();
    let cursor = commit;
    while (cursor !== null) {
      if (seen.has(cursor.hash)) {
        throw new RebaseError('CYCLE', `cyclic ancestry detected at commit ${cursor.number} (${cursor.hash})`);
      }
      seen.add(cursor.hash);
      cursor = cursor.parent === null ? null : byHash.get(cursor.parent);
    }
  }
  return byHash;
}

// Replays history from the roots up to `headHash` and returns the tree state.
// Verifies recorded context snapshot hashes when present.
export function stateAt(byHash, headHash) {
  const head = byHash.get(headHash);
  if (!head) throw new RebaseError('UNKNOWN_HEAD', `unknown commit: ${headHash}`);
  const chain = [];
  let cursor = head;
  while (cursor !== null) {
    chain.push(cursor);
    cursor = cursor.parent === null ? null : byHash.get(cursor.parent);
  }
  chain.reverse();
  const state = {};
  for (const commit of chain) {
    applyPatch(state, commit.patch);
    if (commit.context !== null && commit.context !== snapshotHash(state)) {
      throw new RebaseError('CONTEXT_MISMATCH',
        `commit ${commit.number} (${commit.hash}) recorded context does not match replayed state`);
    }
  }
  return state;
}

function ancestorsOf(byHash, headHash) {
  const result = new Set();
  let cursor = byHash.get(headHash);
  while (cursor) {
    result.add(cursor.hash);
    cursor = cursor.parent === null ? null : byHash.get(cursor.parent);
  }
  return result;
}

// Deterministic topological order (parents before children, ties by number).
export function topoOrder(commits) {
  const byHash = new Map(commits.map((c) => [c.hash, c]));
  const indegree = new Map(commits.map((c) => [c.hash, 0]));
  for (const c of commits) {
    if (c.parent !== null && byHash.has(c.parent)) {
      indegree.set(c.hash, indegree.get(c.hash) + 1);
    }
  }
  const ready = commits.filter((c) => indegree.get(c.hash) === 0)
    .sort((a, b) => a.number - b.number);
  const order = [];
  while (ready.length > 0) {
    const next = ready.shift();
    order.push(next);
    for (const c of commits) {
      if (c.parent === next.hash) {
        indegree.set(c.hash, indegree.get(c.hash) - 1);
        if (indegree.get(c.hash) === 0) {
          ready.push(c);
          ready.sort((a, b) => a.number - b.number);
        }
      }
    }
  }
  if (order.length !== commits.length) {
    throw new RebaseError('CYCLE', 'cyclic ancestry detected during topological sort');
  }
  return order;
}

// Rebases commits reachable from `branchHead` but not from `ontoHash` onto `ontoHash`.
// Returns { commits, mapping, state } where mapping[oldHash] = newHash | null (collapsed).
// Throws RebaseError with code CONFLICT on context conflict; nothing is written by callers in that case.
export function rebase(commits, branchHead, ontoHash) {
  const byHash = validateHistory(commits);
  if (!byHash.has(branchHead)) {
    throw new RebaseError('UNKNOWN_HEAD', `unknown branch head: ${branchHead}`);
  }
  if (!byHash.has(ontoHash)) {
    throw new RebaseError('UNKNOWN_HEAD', `unknown rebase target: ${ontoHash}`);
  }
  const ontoAncestors = ancestorsOf(byHash, ontoHash);
  const branchSet = new Map();
  for (const hash of ancestorsOf(byHash, branchHead)) {
    if (!ontoAncestors.has(hash)) branchSet.set(hash, byHash.get(hash));
  }
  const ordered = topoOrder([...branchSet.values()]);

  let state = stateAt(byHash, ontoHash);
  let parent = ontoHash;
  const newCommits = [];
  const mapping = {};
  for (const commit of ordered) {
    if (commit.patch.length === 0) {
      mapping[commit.hash] = null; // empty patch collapsed, mapping retained
      continue;
    }
    const next = cloneState(state);
    try {
      applyPatch(next, commit.patch);
    } catch (err) {
      if (err instanceof ConflictError) {
        throw new RebaseError('CONFLICT',
          `context conflict rebasing commit ${commit.number} (${commit.hash}): ${err.message}`);
      }
      throw err;
    }
    const context = snapshotHash(next);
    const hash = computeCommitHash({ parent, number: commit.number, patch: commit.patch, context });
    newCommits.push({ hash, parent, number: commit.number, patch: commit.patch, context });
    mapping[commit.hash] = hash;
    state = next;
    parent = hash;
  }
  return { commits: newCommits, mapping, state };
}
