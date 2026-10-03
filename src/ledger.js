// Ledger: domain model + durability. Mutating operations that touch budget
// across nodes (commit, cancel) run as WAL two-phase commits:
//   1. append PREPARE { snapshot, budgetImpact }
//   2. apply mutation, save store
//   3. append COMMIT
// A crash between PREPARE and COMMIT leaves an in-doubt record; recovery on
// open() rolls it back from the snapshot and appends a ROLLBACK record.
import { Store } from './store.js';
import * as model from './model.js';

function takeSnapshot(state, ids) {
  const groups = {};
  for (const id of ids) {
    const g = state.groups[id];
    if (g) groups[id] = { state: g.state, reserved: g.reserved, spent: g.spent };
  }
  return { groups };
}

function restoreSnapshot(state, snapshot) {
  for (const [id, saved] of Object.entries(snapshot.groups)) {
    const g = state.groups[id];
    if (!g) continue;
    g.state = saved.state;
    g.reserved = saved.reserved;
    g.spent = saved.spent;
  }
}

export class Ledger {
  constructor(store, state, seq, recovered) {
    this.store = store;
    this.state = state;
    this.seq = seq;
    this.recovered = recovered; // ROLLBACK records applied during open()
  }

  static open(dir) {
    const store = new Store(dir);
    const state = store.loadState() ?? model.emptyState();
    const wal = store.readWal();
    let seq = wal.reduce((max, r) => Math.max(max, r.seq ?? 0), 0);

    const committed = new Set(wal.filter((r) => r.type === 'COMMIT').map((r) => r.prepareSeq));
    const rolledBack = new Set(wal.filter((r) => r.type === 'ROLLBACK').map((r) => r.prepareSeq));
    const recovered = [];
    let dirty = false;
    for (const rec of wal) {
      if (rec.type !== 'PREPARE' || committed.has(rec.seq) || rolledBack.has(rec.seq)) continue;
      restoreSnapshot(state, rec.snapshot);
      seq += 1;
      const rollback = {
        seq,
        type: 'ROLLBACK',
        prepareSeq: rec.seq,
        op: rec.op,
        groupId: rec.groupId,
        ts: new Date().toISOString(),
      };
      store.appendWal(rollback);
      recovered.push(rollback);
      dirty = true;
    }
    if (dirty) store.saveState(state);
    model.assertInvariants(state);
    return new Ledger(store, state, seq, recovered);
  }

  createGroup(opts) {
    const group = model.createGroup(this.state, opts);
    model.assertInvariants(this.state);
    this.store.saveState(this.state);
    return group;
  }

  prepare(id) {
    const group = model.prepare(this.state, id);
    this.store.saveState(this.state);
    return group;
  }

  // Phase 1 of commit: validate, append WAL PREPARE (subtree snapshot + budget
  // impact), apply the mutation, persist. Used by commit() and by the crash
  // simulator, which stops right after this point.
  beginCommit(id) {
    model.assertCommittable(this.state, id);
    const group = this.state.groups[id];
    const ids = new Set(model.subtreeIds(this.state, id));
    if (group.parentId) ids.add(group.parentId);
    const snapshot = takeSnapshot(this.state, ids);
    const budgetImpact = model.commitImpact(this.state, id);

    const prepareSeq = ++this.seq;
    this.store.appendWal({
      seq: prepareSeq,
      type: 'PREPARE',
      op: 'commit',
      groupId: id,
      snapshot,
      budgetImpact,
      ts: new Date().toISOString(),
    });
    model.applyCommit(this.state, id);
    model.assertInvariants(this.state);
    this.store.saveState(this.state);
    return prepareSeq;
  }

  commit(id) {
    const prepareSeq = this.beginCommit(id);
    this.store.appendWal({
      seq: ++this.seq,
      type: 'COMMIT',
      prepareSeq,
      op: 'commit',
      groupId: id,
      ts: new Date().toISOString(),
    });
    return this.get(id);
  }

  cancel(id) {
    model.assertCancellable(this.state, id);
    const group = this.state.groups[id];
    const ids = new Set(model.subtreeIds(this.state, id));
    if (group.parentId) ids.add(group.parentId);
    const snapshot = takeSnapshot(this.state, ids);

    const prepareSeq = ++this.seq;
    this.store.appendWal({
      seq: prepareSeq,
      type: 'PREPARE',
      op: 'cancel',
      groupId: id,
      snapshot,
      budgetImpact: { groupId: id, note: 'computed by cascade' },
      ts: new Date().toISOString(),
    });
    const result = model.applyCancel(this.state, id);
    model.assertInvariants(this.state);
    this.store.saveState(this.state);
    this.store.appendWal({
      seq: ++this.seq,
      type: 'COMMIT',
      prepareSeq,
      op: 'cancel',
      groupId: id,
      ts: new Date().toISOString(),
    });
    return result;
  }

  get(id) {
    const g = model.getGroup(this.state, id);
    return {
      id: g.id,
      parentId: g.parentId,
      amount: g.amount,
      state: g.state,
      reserved: g.reserved,
      spent: g.spent,
      available: model.available(g),
      children: model.childrenOf(this.state, g.id).map((c) => c.id),
    };
  }

  list() {
    return Object.keys(this.state.groups).sort().map((id) => this.get(id));
  }
}
