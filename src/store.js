import fs from 'node:fs';
import path from 'node:path';
import { GENESIS, verifyBlock } from './block.js';

const INDEX_FILE = 'index.json';

function emptyState() {
  return {
    budgets: {},
    transfers: {},
    pending: [],
    levels: {},
    rolledBack: [],
    missing: {},
    blocks: new Map(),
  };
}

export class Store {
  constructor(dir) {
    this.dir = dir;
    this.blocksDir = path.join(dir, 'blocks');
    this.indexPath = path.join(dir, INDEX_FILE);
    this.state = null;
  }

  load() {
    const state = emptyState();
    if (fs.existsSync(this.indexPath)) {
      const saved = JSON.parse(fs.readFileSync(this.indexPath, 'utf8'));
      state.budgets = saved.budgets ?? {};
      state.transfers = saved.transfers ?? {};
      state.pending = saved.pending ?? [];
      state.levels = saved.levels ?? {};
      state.rolledBack = saved.rolledBack ?? [];
      state.missing = saved.missing ?? {};
    }
    if (fs.existsSync(this.blocksDir)) {
      for (const file of fs.readdirSync(this.blocksDir)) {
        if (!file.endsWith('.json')) continue;
        const fileHash = file.slice(0, -'.json'.length);
        try {
          const block = JSON.parse(fs.readFileSync(path.join(this.blocksDir, file), 'utf8'));
          state.blocks.set(typeof block.hash === 'string' ? block.hash : fileHash, block);
        } catch {
          state.blocks.set(fileHash, { hash: fileHash, corrupt: true });
        }
      }
    }
    this.state = state;
    if (this.recover()) this.save();
    return state;
  }

  recover() {
    const state = this.state;
    let changed = false;
    const indexed = () => new Set(Object.values(state.levels));
    let progress = true;
    while (progress) {
      progress = false;
      for (const [hash, block] of state.blocks) {
        if (indexed().has(hash) || state.rolledBack.includes(hash) || state.missing[hash]) continue;
        if (verifyBlock(block) !== null) continue;
        const slot = String(block.level);
        if (state.levels[slot]) continue;
        const parentActive = block.parent === GENESIS
          ? block.level === 1
          : state.levels[String(block.level - 1)] === block.parent;
        if (!parentActive) continue;
        state.levels[slot] = hash;
        state.pending = state.pending.filter((id) => !block.transfers.includes(id));
        changed = true;
        progress = true;
      }
    }
    for (const [hash, block] of state.blocks) {
      if (indexed().has(hash) || state.rolledBack.includes(hash) || state.missing[hash]) continue;
      if (verifyBlock(block) !== null) continue;
      if (block.parent !== GENESIS && !state.blocks.has(block.parent)) {
        state.missing[hash] = { parent: block.parent, transfers: [...block.transfers] };
        state.pending = state.pending.filter((id) => !block.transfers.includes(id));
        changed = true;
      }
    }
    return changed;
  }

  writeBlock(block) {
    fs.mkdirSync(this.blocksDir, { recursive: true });
    fs.writeFileSync(path.join(this.blocksDir, `${block.hash}.json`), JSON.stringify(block, null, 2));
    this.state.blocks.set(block.hash, block);
  }

  save() {
    const state = this.state;
    fs.mkdirSync(this.dir, { recursive: true });
    const snapshot = {
      budgets: state.budgets,
      transfers: state.transfers,
      pending: state.pending,
      levels: state.levels,
      rolledBack: state.rolledBack,
      missing: state.missing,
    };
    const tmp = `${this.indexPath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(snapshot, null, 2));
    fs.renameSync(tmp, this.indexPath);
  }
}
