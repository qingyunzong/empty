import {
  InputError,
  idCompare,
  validateConfig,
  validateInstruction,
  makeOrderCompare,
  quotaOf,
  hashAssignments,
  canonicalPairs,
} from './model.js';
import { solve } from './solver.js';

// Stateless certificate verification: rebuild the pre-state from the embedded
// snapshot, re-apply the recorded transition and check both hashes.
export function verifyCertificate(cert) {
  if (!cert || typeof cert !== 'object') return { ok: false, code: 'INVALID_CERT' };
  const state = new Map(cert.snapshot);
  if (hashAssignments(state) !== cert.preHash) {
    return { ok: false, code: 'PRE_HASH_MISMATCH', certId: cert.id };
  }
  const { op, instructionId, slot } = cert.replay;
  if (op === 'REMOVE') state.delete(instructionId);
  else if (op === 'ADD' || op === 'MOVE') state.set(instructionId, slot);
  else return { ok: false, code: 'UNKNOWN_OP', certId: cert.id };
  const postHash = hashAssignments(state);
  if (postHash !== cert.postHash) {
    return { ok: false, code: 'POST_HASH_MISMATCH', certId: cert.id, postHash, expected: cert.postHash };
  }
  return { ok: true, certId: cert.id, postHash };
}

export class ClearingHouse {
  constructor(config = {}) {
    this.config = validateConfig(config);
    this.instructions = new Map(); // id -> canonical instruction
    this.status = new Map(); // id -> scheduled|waitlisted|preempted|orphan|undone
    this.assignments = new Map(); // id -> slot
    this.waitAge = new Map(); // id -> accumulated starvation age
    this.stateVersion = new Map(); // id -> version at which it was last confirmed
    this.version = 0;
    this.certSeq = 0;
    this.certificates = [];
    this.errors = [];
  }

  #transition(type, inst, slot, reason, replay, mutate) {
    const snapshot = canonicalPairs(this.assignments).map(([id, s]) => [id, s]);
    const preHash = hashAssignments(this.assignments);
    mutate();
    const postHash = hashAssignments(this.assignments);
    this.certSeq += 1;
    this.certificates.push({
      id: `cert-${this.certSeq}`,
      version: this.version,
      seq: this.certSeq,
      type,
      instruction: {
        id: inst.id,
        institution: inst.institution,
        amount: inst.amount,
        priority: inst.priority,
        slot,
      },
      reason,
      snapshot,
      replay,
      preHash,
      postHash,
    });
  }

  #ageOf(id) {
    const inst = this.instructions.get(id);
    return inst.age + (this.waitAge.get(id) ?? 0);
  }

  #solverView(ids) {
    return ids.map((id) => {
      const inst = this.instructions.get(id);
      return { ...inst, age: this.#ageOf(id) };
    });
  }

  schedule(rawList = []) {
    this.errors = [];
    if (!Array.isArray(rawList)) {
      this.errors.push({ code: 'INVALID', message: 'instructions must be an array' });
      return this.report();
    }
    const preExisting = new Set(this.instructions.keys());
    const valid = [];
    const seen = new Set();
    for (const raw of rawList) {
      try {
        const inst = validateInstruction(raw, this.config);
        if (this.instructions.has(inst.id) || seen.has(inst.id)) {
          throw new InputError('DUPLICATE', `duplicate instruction id ${inst.id}`, inst.id);
        }
        seen.add(inst.id);
        valid.push(inst);
      } catch (err) {
        if (err instanceof InputError) {
          this.errors.push({ code: err.code, message: err.message, ...(err.id ? { id: err.id } : {}) });
        } else {
          throw err;
        }
      }
    }
    const knownIds = new Set([...this.instructions.keys(), ...valid.map((i) => i.id)]);
    const accepted = [];
    for (const inst of valid) {
      const unknown = inst.deps.filter((d) => !knownIds.has(d));
      if (unknown.length > 0) {
        this.errors.push({
          code: 'UNKNOWN_DEP',
          id: inst.id,
          message: `instruction ${inst.id} depends on unknown instruction(s): ${unknown.join(', ')}`,
        });
      } else {
        accepted.push(inst);
      }
    }
    const cyclic = this.#findCyclic(accepted);
    for (const id of [...cyclic].sort(idCompare)) {
      this.errors.push({ code: 'CYCLE', id, message: `instruction ${id} is part of a dependency cycle` });
    }
    for (const inst of accepted) {
      if (cyclic.has(inst.id)) continue;
      this.instructions.set(inst.id, inst);
      this.status.set(inst.id, 'waitlisted');
      this.waitAge.set(inst.id, 0);
    }
    // Starvation aging: previously known, still unscheduled instructions age.
    for (const id of preExisting) {
      const st = this.status.get(id);
      if (st === 'waitlisted' || st === 'preempted' || st === 'orphan') {
        this.waitAge.set(id, (this.waitAge.get(id) ?? 0) + 1);
      }
    }
    const candidateIds = [...this.instructions.keys()].filter((id) => this.status.get(id) !== 'undone');
    const { assignments } = solve({ instructions: this.#solverView(candidateIds), ...this.config });
    this.version += 1;
    const commitVersion = this.version;
    const removed = [...this.assignments.keys()].filter((id) => !assignments.has(id)).sort(idCompare);
    const kept = [...this.assignments.keys()].filter((id) => assignments.has(id));
    const moved = kept.filter((id) => this.assignments.get(id) !== assignments.get(id)).sort(idCompare);
    const added = [...assignments.keys()].filter((id) => !this.assignments.has(id)).sort(idCompare);
    for (const id of removed) {
      const inst = this.instructions.get(id);
      const slot = this.assignments.get(id);
      this.#transition('PREEMPT', inst, slot, 'displaced by higher-priority demand', { op: 'REMOVE', instructionId: id, slot }, () => {
        this.assignments.delete(id);
        this.status.set(id, 'preempted');
      });
    }
    for (const id of moved) {
      const inst = this.instructions.get(id);
      const fromSlot = this.assignments.get(id);
      const slot = assignments.get(id);
      this.#transition('MOVE', inst, slot, `reassigned from slot ${fromSlot} to slot ${slot}`, { op: 'MOVE', instructionId: id, fromSlot, slot }, () => {
        this.assignments.set(id, slot);
      });
    }
    for (const id of added) {
      const inst = this.instructions.get(id);
      const slot = assignments.get(id);
      this.#transition('CONFIRM', inst, slot, 'scheduled', { op: 'ADD', instructionId: id, slot }, () => {
        this.assignments.set(id, slot);
        this.status.set(id, 'scheduled');
        this.stateVersion.set(id, commitVersion);
      });
    }
    this.#classifyUnscheduled(candidateIds, assignments);
    return this.report();
  }

  #classifyUnscheduled(candidateIds, assignments) {
    const usage = new Map();
    for (const id of assignments.keys()) {
      const inst = this.instructions.get(id);
      usage.set(inst.institution, (usage.get(inst.institution) ?? 0) + 1);
    }
    const entries = [];
    for (const id of candidateIds) {
      if (assignments.has(id)) continue;
      const inst = this.instructions.get(id);
      const missingDeps = inst.deps.filter((d) => !assignments.has(d));
      if (missingDeps.length > 0) {
        entries.push({
          code: 'DEP',
          id,
          message: `instruction ${id} cannot be scheduled because dependenc${missingDeps.length > 1 ? 'ies' : 'y'} ${missingDeps.join(', ')} ${missingDeps.length > 1 ? 'are' : 'is'} not scheduled`,
        });
      } else if ((usage.get(inst.institution) ?? 0) >= quotaOf(this.config.quotas, inst.institution)) {
        entries.push({
          code: 'QUOTA',
          id,
          message: `instruction ${id} exceeds quota ${this.config.quotas[inst.institution]} of institution ${inst.institution}`,
        });
      } else {
        entries.push({
          code: 'CAPACITY',
          id,
          message: `instruction ${id} finds no free slot within deadline ${inst.deadline}`,
        });
      }
    }
    entries.sort((a, b) => idCompare(a.id, b.id) || idCompare(a.code, b.code));
    this.errors.push(...entries);
  }

  undo(id, expectedVersion) {
    this.errors = [];
    if (typeof id !== 'string' || id.length === 0) {
      this.errors.push({ code: 'INVALID', message: 'undo requires a non-empty instruction id' });
      return this.report();
    }
    const inst = this.instructions.get(id);
    if (!inst || this.status.get(id) !== 'scheduled') {
      this.errors.push({ code: 'STALE_UNDO', id, message: `instruction ${id} is not in a confirmed state` });
      return this.report();
    }
    if (expectedVersion !== undefined && expectedVersion !== this.stateVersion.get(id)) {
      this.errors.push({
        code: 'STALE_UNDO',
        id,
        message: `instruction ${id} was confirmed at version ${this.stateVersion.get(id)}, not ${expectedVersion}`,
      });
      return this.report();
    }
    this.version += 1;
    const commitVersion = this.version;
    const slot = this.assignments.get(id);
    this.#transition('UNDO', inst, slot, 'explicit undo of confirmed instruction', { op: 'REMOVE', instructionId: id, slot }, () => {
      this.assignments.delete(id);
      this.status.set(id, 'undone');
    });
    // Cascade: scheduled instructions whose dependency chain reaches the
    // undone instruction become orphans and release their slot and quota.
    const dependents = new Map();
    for (const [otherId, other] of this.instructions) {
      for (const dep of other.deps) {
        if (!dependents.has(dep)) dependents.set(dep, []);
        dependents.get(dep).push(otherId);
      }
    }
    const queue = [id];
    const orphaned = new Set([id]);
    while (queue.length > 0) {
      const cur = queue.shift();
      for (const depId of (dependents.get(cur) ?? []).sort(idCompare)) {
        if (orphaned.has(depId)) continue;
        orphaned.add(depId);
        if (this.status.get(depId) === 'scheduled') {
          const depInst = this.instructions.get(depId);
          const depSlot = this.assignments.get(depId);
          this.#transition('ORPHAN', depInst, depSlot, `dependency ${cur} was undone`, { op: 'REMOVE', instructionId: depId, slot: depSlot }, () => {
            this.assignments.delete(depId);
            this.status.set(depId, 'orphan');
          });
        } else if (this.status.get(depId) !== 'undone') {
          this.status.set(depId, 'orphan');
        }
        queue.push(depId);
      }
    }
    this.#repair(commitVersion);
    return this.report();
  }

  // Incremental repair: only waitlisted/preempted/orphan instructions are
  // reconsidered, placed into freed resources without moving any confirmed
  // assignment. Repeats until fixpoint so restored deps can unblock others.
  #repair(commitVersion) {
    const { slots, capacity, quotas, agingFactor } = this.config;
    let changed = true;
    while (changed) {
      changed = false;
      const candidateIds = [...this.status.entries()]
        .filter(([, st]) => st === 'waitlisted' || st === 'preempted' || st === 'orphan')
        .map(([cid]) => cid);
      const candidates = this.#solverView(candidateIds).sort(makeOrderCompare(agingFactor));
      for (const inst of candidates) {
        if (this.status.get(inst.id) === 'scheduled') continue;
        let minSlot = 1;
        let depsOk = true;
        for (const dep of inst.deps) {
          if (!this.assignments.has(dep)) {
            depsOk = false;
            break;
          }
          const depSlot = this.assignments.get(dep);
          if (depSlot + 1 > minSlot) minSlot = depSlot + 1;
        }
        if (!depsOk) continue;
        const used = [...this.assignments.keys()].filter((aid) => this.instructions.get(aid).institution === inst.institution).length;
        if (used >= quotaOf(quotas, inst.institution)) continue;
        const slotLoad = new Array(slots + 1).fill(0);
        for (const s of this.assignments.values()) slotLoad[s] += 1;
        for (let s = minSlot; s <= inst.deadline; s += 1) {
          if (slotLoad[s] < capacity) {
            const stored = this.instructions.get(inst.id);
            this.#transition('RESTORE', stored, s, 'incremental repair after undo', { op: 'ADD', instructionId: inst.id, slot: s }, () => {
              this.assignments.set(inst.id, s);
              this.status.set(inst.id, 'scheduled');
              this.stateVersion.set(inst.id, commitVersion);
            });
            changed = true;
            break;
          }
        }
      }
    }
  }

  replayCertificate(certId) {
    const cert = this.certificates.find((c) => c.id === certId);
    if (!cert) return { ok: false, code: 'UNKNOWN_CERT', certId };
    return verifyCertificate(cert);
  }

  report() {
    const schedule = [...this.assignments.entries()]
      .map(([id, slot]) => ({ id, slot }))
      .sort((a, b) => a.slot - b.slot || idCompare(a.id, b.id))
      .map(({ id, slot }) => {
        const inst = this.instructions.get(id);
        const age = this.#ageOf(id);
        return {
          id,
          institution: inst.institution,
          slot,
          amount: inst.amount,
          priority: inst.priority,
          age,
          effectivePriority: inst.priority + this.config.agingFactor * age,
          deadline: inst.deadline,
          deps: inst.deps,
          confirmedAt: this.stateVersion.get(id),
        };
      });
    const waitlist = [...this.status.entries()]
      .filter(([, st]) => st === 'waitlisted' || st === 'preempted')
      .map(([id]) => id)
      .sort(idCompare);
    const orphans = [...this.status.entries()]
      .filter(([, st]) => st === 'orphan')
      .map(([id]) => id)
      .sort(idCompare);
    return {
      version: this.version,
      schedule,
      waitlist,
      orphans,
      certificates: this.certificates,
      errors: this.errors,
    };
  }

  // Nodes of `accepted` that participate in a dependency cycle. Deps pointing
  // outside `accepted` cannot close a cycle (existing instructions never
  // depend on newer ones), so only internal edges are followed.
  #findCyclic(accepted) {
    const byId = new Map(accepted.map((i) => [i.id, i]));
    const color = new Map(accepted.map((i) => [i.id, 0]));
    const cyclic = new Set();
    const stack = [];
    const visit = (id) => {
      color.set(id, 1);
      stack.push(id);
      for (const dep of byId.get(id).deps) {
        if (!byId.has(dep)) continue;
        const c = color.get(dep);
        if (c === 0) {
          visit(dep);
        } else if (c === 1) {
          const start = stack.indexOf(dep);
          for (let i = start; i < stack.length; i += 1) cyclic.add(stack[i]);
        }
      }
      stack.pop();
      color.set(id, 2);
    };
    for (const inst of [...accepted].sort((a, b) => idCompare(a.id, b.id))) {
      if (color.get(inst.id) === 0) visit(inst.id);
    }
    return cyclic;
  }
}
