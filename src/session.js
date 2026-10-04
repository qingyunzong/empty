import { mergeBranches, applyResolution, refreshDerived } from './merge.js';
import { transitiveDependents } from './graph.js';
import { canonical } from './canonical.js';

function err(code, message, extra = {}) {
  const e = new Error(message);
  e.code = code;
  Object.assign(e, extra);
  return e;
}

// A merge session tracks resolutions across source-branch changes. Each
// resolve() applies immediately and incrementally refreshes the affected
// dependency region, blocked state and the replayable topo certificate.
export class MergeSession {
  constructor({ base, local, remote, versions = {} }) {
    this.branches = { base, local, remote };
    this.versions = { base: null, local: null, remote: null, ...versions };
    this.resolutions = new Map();
    this.result = mergeBranches(base, local, remote, []);
    this.lastAffected = [];
  }

  activeResolutions() {
    return [...this.resolutions.values()]
      .filter((r) => r.status === 'ACTIVE')
      .map(({ conflictId, pick }) => ({ conflictId, pick }));
  }

  unresolvedConflicts() {
    return this.result.conflicts.filter((c) => this.resolutions.get(c.conflictId)?.status !== 'ACTIVE');
  }

  resolve({ conflictId, expectLocal, expectRemote, expectLocalVersion, expectRemoteVersion, pick }) {
    const c = this.result.conflicts.find((x) => x.conflictId === conflictId);
    if (!c) throw err('UNKNOWN_CONFLICT', `no conflict ${conflictId}`);
    if (pick !== 'local' && pick !== 'remote') throw err('BAD_PICK', 'pick must be local or remote');
    if (canonical(c.local) !== canonical(expectLocal) || canonical(c.remote) !== canonical(expectRemote)) {
      throw err('PRECONDITION_FAILED', 'source versions of the conflict do not match expectations');
    }
    if (expectLocalVersion !== undefined && expectLocalVersion !== this.versions.local) {
      throw err('PRECONDITION_FAILED', 'local branch version mismatch');
    }
    if (expectRemoteVersion !== undefined && expectRemoteVersion !== this.versions.remote) {
      throw err('PRECONDITION_FAILED', 'remote branch version mismatch');
    }
    this.resolutions.set(conflictId, { conflictId, pick, expectLocal, expectRemote, status: 'ACTIVE' });
    this.#incrementalUpdate(c, pick);
    return { ok: true, conflictId, affected: [...this.lastAffected].sort() };
  }

  #incrementalUpdate(conflict, pick) {
    const id = conflict.eventId;
    const before = transitiveDependents(this.result.events, [id]);
    applyResolution(this.result.events, conflict, pick);
    const after = transitiveDependents(this.result.events, [id]);
    const region = new Set([...before, ...after]);
    if (!this.result.appliedResolutions.includes(conflict.conflictId)) {
      this.result.appliedResolutions.push(conflict.conflictId);
    }
    refreshDerived(this.result, region);
    this.lastAffected = region;
  }

  // Source branch changed: recompute the merge. Resolutions whose
  // source-version preconditions still hold carry over; the rest become
  // STALE_RESOLUTION and are not applied.
  updateBranch(side, events, version = null) {
    if (!['local', 'remote', 'base'].includes(side)) throw err('BAD_SIDE', `unknown side ${side}`);
    this.branches[side] = events;
    if (version !== null) this.versions[side] = version;
    const fresh = mergeBranches(this.branches.base, this.branches.local, this.branches.remote, []);
    const freshIds = new Set(fresh.conflicts.map((c) => c.conflictId));
    const carried = [];
    const stale = [];
    for (const res of this.resolutions.values()) {
      if (res.status !== 'ACTIVE') {
        stale.push(res.conflictId);
        continue;
      }
      if (freshIds.has(res.conflictId)) carried.push(res.conflictId);
      else {
        res.status = 'STALE_RESOLUTION';
        stale.push(res.conflictId);
      }
    }
    this.result = mergeBranches(this.branches.base, this.branches.local, this.branches.remote, this.activeResolutions());
    this.lastAffected = [];
    return { carried, stale };
  }

  // Atomic only in the sense that nothing is written unless every conflict
  // is resolved and the graph is valid.
  commit(store) {
    const unresolved = this.unresolvedConflicts();
    if (unresolved.length) {
      throw err('UNRESOLVED_CONFLICTS', 'cannot commit with unresolved conflicts', {
        conflicts: unresolved.map((c) => c.conflictId),
      });
    }
    if (this.result.cycle) throw err('CYCLE', 'cannot commit: merged graph has a causal cycle');
    if (this.result.missingRefs.length) throw err('MISSING_REFS', 'cannot commit: dangling dependencies');
    const parents = [this.versions.local, this.versions.remote].filter(Boolean);
    return store.commitMerge({
      events: this.result.events,
      parents,
      meta: {
        kind: 'merge',
        base: this.versions.base,
        local: this.versions.local,
        remote: this.versions.remote,
        conflicts: this.result.conflicts,
        resolutions: [...this.resolutions.values()],
        blocked: this.result.blocked,
        cycle: this.result.cycle,
        certificate: this.result.certificate,
      },
    });
  }
}
