import { GENESIS, createBlock, verifyBlock } from './block.js';
import { netDeltas, selectSettleable } from './selection.js';

export class Conflict extends Error {}

export function tipLevel(state) {
  const keys = Object.keys(state.levels).map(Number);
  return keys.length > 0 ? Math.max(...keys) : 0;
}

export function chainBlocks(state) {
  const tip = tipLevel(state);
  const chain = [];
  for (let level = 1; level <= tip; level += 1) {
    const hash = state.levels[String(level)];
    if (!hash) break;
    const block = state.blocks.get(hash);
    if (!block) break;
    chain.push(block);
  }
  return chain;
}

export function cumulative(state) {
  const totals = {};
  for (const block of chainBlocks(state)) {
    for (const [party, delta] of Object.entries(block.deltas)) {
      totals[party] = (totals[party] ?? 0) + delta;
    }
  }
  return totals;
}

function buildBlock(level, parent, selected) {
  const sorted = [...selected].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return createBlock({
    level,
    parent,
    transfers: sorted.map((t) => t.id),
    deltas: netDeltas(sorted),
    index: sorted.map((t) => ({ id: t.id, from: t.from, to: t.to, amount: t.amount })),
  });
}

function settle(state, selected) {
  const ids = new Set(selected.map((t) => t.id));
  state.pending = state.pending.filter((id) => !ids.has(id));
}

export function propose(store, { id, from, to, amount }) {
  const state = store.state;
  if (!id || typeof id !== 'string') throw new Conflict('INVALID_TRANSFER_ID');
  if (!from || !to || typeof from !== 'string' || typeof to !== 'string') {
    throw new Conflict('INVALID_PARTIES');
  }
  if (from === to) throw new Conflict('SELF_TRANSFER');
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new Conflict('INVALID_AMOUNT');
  if (state.transfers[id]) throw new Conflict(`DUPLICATE_TRANSFER ${id}`);
  state.transfers[id] = { id, from, to, amount };
  state.pending.push(id);
  state.pending.sort();
  return state.transfers[id];
}

export function finalize(store) {
  const state = store.state;
  const pending = state.pending.map((id) => state.transfers[id]);
  if (pending.length === 0) throw new Conflict('NO_PENDING_TRANSFERS');
  const selected = selectSettleable(pending, state.budgets, cumulative(state));
  if (selected.length === 0) throw new Conflict('NO_SETTLEABLE_TRANSFERS');
  const level = tipLevel(state) + 1;
  const parent = level === 1 ? GENESIS : state.levels[String(level - 1)];
  const block = buildBlock(level, parent, selected);
  store.writeBlock(block);
  state.levels[String(level)] = block.hash;
  settle(state, selected);
  return block;
}

function cascadeRollback(state, level) {
  const tip = tipLevel(state);
  const rolled = [];
  for (let l = tip; l >= level; l -= 1) {
    const hash = state.levels[String(l)];
    if (!hash) continue;
    const block = state.blocks.get(hash);
    delete state.levels[String(l)];
    state.rolledBack.push(hash);
    if (block) {
      rolled.push(block);
      for (const id of block.transfers) {
        if (!state.pending.includes(id)) state.pending.push(id);
      }
    }
  }
  state.pending.sort();
  return rolled;
}

export function correct(store, level) {
  const state = store.state;
  if (!Number.isSafeInteger(level) || level < 1) throw new Conflict('INVALID_LEVEL');
  if (!state.levels[String(level)]) throw new Conflict(`LEVEL_NOT_FINAL ${level}`);
  const rolled = cascadeRollback(state, level);
  const pending = state.pending.map((id) => state.transfers[id]);
  const selected = selectSettleable(pending, state.budgets, cumulative(state));
  const parent = level === 1 ? GENESIS : state.levels[String(level - 1)];
  const block = buildBlock(level, parent, selected);
  store.writeBlock(block);
  state.levels[String(level)] = block.hash;
  settle(state, selected);
  return { block, rolled };
}

export function rollback(store, level) {
  const state = store.state;
  if (!Number.isSafeInteger(level) || level < 1) throw new Conflict('INVALID_LEVEL');
  if (!state.levels[String(level)]) throw new Conflict(`LEVEL_NOT_FINAL ${level}`);
  return cascadeRollback(state, level);
}

export function verify(store) {
  const state = store.state;
  const issues = [];
  for (const [hash, block] of state.blocks) {
    if (verifyBlock(block) !== null) {
      issues.push({ code: 'CORRUPT', hash, detail: 'checksum-mismatch' });
      continue;
    }
    if (block.parent === GENESIS) {
      if (block.level !== 1) issues.push({ code: 'CORRUPT', hash, detail: 'bad-genesis-level' });
      continue;
    }
    const parent = state.blocks.get(block.parent);
    if (!parent) {
      issues.push({ code: 'MISSING', hash, detail: `parent ${block.parent}` });
    } else if (verifyBlock(parent) === null && parent.level + 1 !== block.level) {
      issues.push({ code: 'CORRUPT', hash, detail: 'level-mismatch' });
    }
  }
  return issues;
}

export function report(store) {
  const state = store.state;
  const chain = chainBlocks(state);
  const balances = {};
  for (const block of chain) {
    for (const [party, delta] of Object.entries(block.deltas)) {
      balances[party] = (balances[party] ?? 0) + delta;
    }
  }
  const remaining = {};
  for (const [party, limit] of Object.entries(state.budgets)) {
    remaining[party] = limit - (balances[party] ?? 0);
  }
  return {
    tip: chain.length > 0 ? chain[chain.length - 1].hash : null,
    tipLevel: chain.length,
    levels: chain.map((b) => ({
      level: b.level,
      hash: b.hash,
      crc: b.crc,
      parent: b.parent,
      transfers: b.transfers,
      deltas: b.deltas,
      status: 'final',
    })),
    balances,
    budgets: state.budgets,
    remaining,
    pending: [...state.pending].sort(),
    settled: chain.flatMap((b) => b.transfers).sort(),
    rolledBack: state.rolledBack.map((hash) => {
      const block = state.blocks.get(hash);
      return block && Number.isSafeInteger(block.level)
        ? { hash, level: block.level }
        : { hash };
    }),
    missing: Object.entries(state.missing).map(([hash, m]) => ({
      hash,
      parent: m.parent,
      transfers: m.transfers,
    })),
  };
}
