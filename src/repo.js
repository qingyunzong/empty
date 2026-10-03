// Repository: holds the three source branches, runs merges, tracks
// resolutions (with source-version preconditions), commits immutable
// snapshots, and provides diffs / verified inverse diffs.

import { hash, deepEqual, clone, deepFreeze } from './util.js';
import { validateBranch } from './events.js';
import { mergeBranches } from './merge.js';
import { computeDerived, computeBlocked, computeBlockedIncremental } from './derive.js';

export class Repo {
  constructor() {
    this.reset();
  }

  reset() {
    this.branches = {}; // name -> {id: event}
    this.resolutions = new Map(); // `${conflictId}|${field}` -> entry
    this.mergeState = null;
    this.snapshots = new Map();
    this.history = [];
    this.index = null;
  }

  loadBranch(name, rawEvents) {
    if (!['base', 'local', 'remote'].includes(name)) throw new Error(`unknown branch ${name}`);
    this.branches[name] = validateBranch(rawEvents, name);
    return { branch: name, events: Object.keys(this.branches[name]).length };
  }

  branchEvents() {
    return { base: this.branches.base ?? {}, local: this.branches.local ?? {}, remote: this.branches.remote ?? {} };
  }

  // Applies ACTIVE resolutions onto the tentative merge.
  applyResolutions(tentative, conflicts) {
    const events = clone(tentative);
    const dependsOnOrigin = new Map();
    for (const entry of this.resolutions.values()) {
      if (entry.status !== 'ACTIVE') continue;
      const conflict = conflicts.get(entry.conflictId);
      if (!conflict) continue;
      const v = conflict.fields[entry.field];
      if (!v) continue;
      const value = entry.choice === 'local' ? v.local : v.remote;
      if (entry.field === 'presence') {
        if (value === 'absent') delete events[conflict.eventId];
      } else if (entry.field === 'dependsOn') {
        if (events[conflict.eventId]) {
          events[conflict.eventId].dependsOn = [...value].sort();
          dependsOnOrigin.set(conflict.eventId, entry.choice);
        }
      } else if (events[conflict.eventId]) {
        events[conflict.eventId][entry.field] = clone(value);
      }
    }
    return { events, dependsOnOrigin };
  }

  merge() {
    const branches = this.branchEvents();
    const { events: tentative, conflicts } = mergeBranches(branches.base, branches.local, branches.remote);

    // Re-validate every recorded resolution against the new source versions.
    for (const entry of this.resolutions.values()) {
      const conflict = conflicts.get(entry.conflictId);
      const v = conflict && conflict.fields[entry.field];
      entry.status = v && deepEqual(v.local, entry.versions.local) && deepEqual(v.remote, entry.versions.remote)
        ? 'ACTIVE'
        : 'STALE_RESOLUTION';
    }

    const { events, dependsOnOrigin } = this.applyResolutions(tentative, conflicts);
    const derived = computeDerived(events, branches, dependsOnOrigin);
    this.mergeState = { tentative, conflicts, events, dependsOnOrigin, derived };
    return this.status();
  }

  unresolvedConflicts() {
    if (!this.mergeState) return [];
    const out = [];
    for (const conflict of this.mergeState.conflicts.values()) {
      const missing = Object.keys(conflict.fields).filter((f) => {
        const entry = this.resolutions.get(`${conflict.id}|${f}`);
        return !entry || entry.status !== 'ACTIVE';
      });
      if (missing.length > 0) out.push({ ...conflict, unresolvedFields: missing.sort() });
    }
    return out.sort((a, b) => (a.id < b.id ? -1 : 1));
  }

  resolve({ conflictId, field, choice, expect }) {
    if (!this.mergeState) throw new Error('no merge in progress');
    const conflict = this.mergeState.conflicts.get(conflictId);
    if (!conflict) throw new Error(`unknown conflict ${conflictId}`);
    const v = conflict.fields[field];
    if (!v) throw new Error(`conflict ${conflictId} has no contested field ${field}`);
    if (choice !== 'local' && choice !== 'remote') throw new Error('choice must be local or remote');
    if (expect && (!deepEqual(expect.local, v.local) || !deepEqual(expect.remote, v.remote))) {
      const err = new Error('resolution preconditions do not match current source versions');
      err.code = 'PRECONDITION_FAILED';
      throw err;
    }

    const eventId = conflict.eventId;
    this.resolutions.set(`${conflictId}|${field}`, {
      conflictId, field, choice,
      versions: { local: clone(v.local), remote: clone(v.remote) },
      status: 'ACTIVE',
    });

    // Incremental update of the affected dependency region.
    const prevBlocked = this.mergeState.derived.blocked;
    const { events, dependsOnOrigin } = this.applyResolutions(this.mergeState.tentative, this.mergeState.conflicts);
    const derived = computeDerived(events, this.branchEvents(), dependsOnOrigin);
    derived.blocked = computeBlockedIncremental(events, prevBlocked, new Set([eventId]));
    this.mergeState = { ...this.mergeState, events, dependsOnOrigin, derived };
    return this.status();
  }

  status() {
    const ms = this.mergeState;
    return {
      branches: Object.fromEntries(Object.entries(this.branches).map(([n, ev]) => [n, Object.keys(ev).length])),
      conflicts: ms ? [...ms.conflicts.values()] : [],
      unresolved: this.unresolvedConflicts().map((c) => c.id),
      staleResolutions: [...this.resolutions.values()].filter((r) => r.status === 'STALE_RESOLUTION'),
      cycle: ms ? ms.derived.cycle : null,
      graphErrors: ms ? ms.derived.errors : [],
      blocked: ms ? ms.derived.blocked : [],
      order: ms ? ms.derived.order : null,
      index: this.index,
      snapshots: this.history.length,
    };
  }

  projection() {
    if (!this.mergeState) throw new Error('no merge in progress');
    const { events, derived } = this.mergeState;
    const order = derived.order ?? Object.keys(events).sort();
    return {
      events: order.filter((id) => events[id] && !events[id].deleted).map((id) => clone(events[id])),
      blocked: clone(derived.blocked),
    };
  }

  certificate() {
    if (!this.mergeState) throw new Error('no merge in progress');
    const { events, derived, conflicts } = this.mergeState;
    if (!derived.order) return null;
    return {
      order: derived.order,
      rounds: derived.rounds,
      edges: derived.edges,
      eventImageHash: hash({ events, topoOrder: derived.order }),
      conflicts: [...conflicts.values()],
    };
  }

  mergeCommit() {
    if (!this.mergeState) throw new Error('no merge in progress');
    const unresolved = this.unresolvedConflicts();
    if (unresolved.length > 0) {
      const err = new Error(`unresolved conflicts: ${unresolved.map((c) => c.id).join(', ')}`);
      err.code = 'UNRESOLVED_CONFLICTS';
      throw err;
    }
    if (this.mergeState.derived.errors.length > 0 || this.mergeState.derived.cycle) {
      const err = new Error('merged graph is not valid (missing references or cycle)');
      err.code = 'INVALID_GRAPH';
      throw err;
    }
    const { events, derived, conflicts } = this.mergeState;
    const image = { events: clone(events), topoOrder: [...derived.order] };
    const imageHash = hash(image);
    const parents = this.index ? [this.index] : [];
    const id = hash({ imageHash, parents });
    const snapshot = deepFreeze({
      id,
      imageHash,
      parents,
      inputs: clone(this.branchEvents()),
      events: image.events,
      topoOrder: image.topoOrder,
      certificate: { order: [...derived.order], rounds: clone(derived.rounds), edges: clone(derived.edges) },
      blocked: clone(derived.blocked),
      conflicts: clone([...conflicts.values()]),
      resolutions: clone([...this.resolutions.values()].filter((r) => r.status === 'ACTIVE')),
    });
    // Atomic publish: the snapshot is fully built and frozen before any
    // repository structure is mutated.
    this.snapshots.set(id, snapshot);
    this.history.push(id);
    this.index = id;
    return { snapshotId: id, parents, imageHash };
  }

  diffEvents(fromEvents, fromOrder, toEvents, toOrder) {
    const ops = [];
    const ids = [...new Set([...Object.keys(fromEvents), ...Object.keys(toEvents)])].sort();
    for (const id of ids) {
      const a = fromEvents[id];
      const b = toEvents[id];
      if (a && !b) ops.push({ op: 'removeEvent', id });
      else if (!a && b) ops.push({ op: 'putEvent', id, event: clone(b) });
      else if (!deepEqual(a, b)) ops.push({ op: 'putEvent', id, event: clone(b) });
    }
    if (!deepEqual(fromOrder, toOrder)) ops.push({ op: 'setOrder', order: [...toOrder] });
    return ops;
  }

  diff(fromId, toId, inverse = false) {
    const from = this.snapshots.get(fromId);
    const to = this.snapshots.get(toId);
    if (!from) throw new Error(`unknown snapshot ${fromId}`);
    if (!to) throw new Error(`unknown snapshot ${toId}`);
    return {
      inverse,
      from: from.id,
      to: to.id,
      fromImage: from.imageHash,
      postImageHash: to.imageHash,
      ops: this.diffEvents(from.events, from.topoOrder, to.events, to.topoOrder),
    };
  }

  inverseDiff(oldId, newId) {
    return this.diff(newId, oldId, true);
  }

  // Applies an inverse diff to roll the index back. The post-image hash is
  // verified; any failure leaves history and index untouched.
  applyInverseDiff(diff) {
    if (!diff || diff.inverse !== true) throw new Error('not an inverse diff');
    if (!this.index) throw new Error('no current snapshot');
    const current = this.snapshots.get(this.index);
    if (current.imageHash !== diff.fromImage) {
      const err = new Error('inverse diff does not apply to the current snapshot image');
      err.code = 'PREIMAGE_MISMATCH';
      throw err;
    }
    const events = clone(current.events);
    let order = [...current.topoOrder];
    for (const op of diff.ops) {
      if (op.op === 'putEvent') events[op.id] = clone(op.event);
      else if (op.op === 'removeEvent') delete events[op.id];
      else if (op.op === 'setOrder') order = [...op.order];
      else {
        const err = new Error(`unknown diff op ${op.op}`);
        err.code = 'BAD_DIFF';
        throw err;
      }
    }
    const imageHash = hash({ events, topoOrder: order });
    if (imageHash !== diff.postImageHash) {
      const err = new Error('post-image hash mismatch; history and index unchanged');
      err.code = 'POST_IMAGE_MISMATCH';
      throw err;
    }
    const target = [...this.snapshots.values()].find((s) => s.imageHash === imageHash);
    if (!target) {
      const err = new Error('post-image matches no known snapshot');
      err.code = 'UNKNOWN_IMAGE';
      throw err;
    }
    this.index = target.id;
    return { index: this.index, imageHash };
  }
}
