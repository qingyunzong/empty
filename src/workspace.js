// Workspace: orchestrates model + solver + store. One Workspace per terminal
// (data directory). All mutations go through applyBatch, which journals,
// applies, recomputes incrementally, and snapshots atomically.

import {
  MoldPlanError,
  emptyState,
  applyInverse,
  beginBatch,
  recordChange,
  rollbackLastBatch,
  recomputeIncremental,
  recomputeFull,
  stateToJSON,
} from './model.js';
import { solve } from './solver.js';
import { Store } from './store.js';

export class Workspace {
  constructor(dir, terminalId = 'T1') {
    this.store = new Store(dir);
    this.terminalId = terminalId;
    this.state = null;
    this.vector = {}; // terminalId -> last applied batch seq
    this.recovered = null;
  }

  open() {
    const { snapshot, journalRecords, recovered } = this.store.open();
    this.recovered = recovered;
    if (snapshot) {
      this.state = snapshot;
      this.vector = this.store.readManifest()?.vector ?? {};
    } else {
      this.state = emptyState();
      this.vector = {};
      for (const rec of journalRecords) {
        this.replayRecord(rec);
      }
      recomputeFull(this.state);
    }
    return this;
  }

  replayRecord(rec) {
    if (rec.type === 'batch') {
      const batch = beginBatch(this.state, rec.lockedMolds);
      for (const change of rec.changes) {
        recordChange(this.state, batch, change);
      }
      batch.origin = rec.origin;
      if (rec.origin) this.vector[rec.origin.terminal] = rec.origin.seq;
    }
  }

  // Apply a batch of changes atomically: journal first, then mutate, then
  // incrementally recompute, then snapshot. Returns the batch record.
  applyBatch(changes, { lockedMolds = [], origin = null } = {}) {
    const batch = beginBatch(this.state, lockedMolds);
    const applied = [];
    try {
      for (const change of changes) {
        recordChange(this.state, batch, change);
        applied.push(change);
      }
    } catch (err) {
      // undo partial batch in reverse, then drop it
      for (let i = batch.changes.length - 1; i >= 0; i--) {
        const ch = batch.changes[i];
        applyInverse(this.state, ch.inverse);
      }
      this.state.batches.pop();
      this.state.nextBatchSeq -= 1;
      recomputeFull(this.state);
      throw err;
    }
    const seq = origin ? origin.seq : this.bumpVector();
    const rec = {
      type: 'batch',
      id: batch.id,
      origin: { terminal: origin ? origin.terminal : this.terminalId, seq },
      lockedMolds: batch.lockedMolds,
      changes: applied,
    };
    batch.origin = rec.origin;
    this.store.journal.append(rec);
    const dirty = changes
      .filter((c) => c.type === 'assign' || c.type === 'unassign')
      .map((c) => c.jobId);
    recomputeIncremental(this.state, dirty);
    this.store.commitPlan(this.state);
    this.store.commitManifest(this.manifest());
    return rec;
  }

  bumpVector() {
    const next = (this.vector[this.terminalId] ?? 0) + 1;
    this.vector[this.terminalId] = next;
    return next;
  }

  manifest() {
    return {
      vector: { ...this.vector },
      shiftLoad: [...this.state.shiftLoad],
      budgets: this.state.calendar.shifts.map((s) => s.budget),
      feasible: this.state.feasible,
      pending: this.state.pending,
    };
  }

  // Solve the whole current job set and replace the assignment with the
  // canonical optimal plan (fixed tie-break). Changes are captured as
  // unassign/assign pairs in a single batch.
  plan({ lockedMolds = [] } = {}) {
    const jobs = [...this.state.jobs.values()];
    const molds = [...this.state.molds.values()];
    const shifts = this.state.calendar.shifts;
    const best = solve(jobs, molds, shifts);
    if (!best) {
      // Budget insufficient (or otherwise unsatisfiable): mark infeasible but
      // keep the most recent feasible certificate; pending stays pending,
      // never reported as unsatisfiable.
      this.state.feasible = false;
      return { feasible: false, certificate: this.state.certificate, pending: this.state.pending };
    }
    const changes = [];
    const target = new Map(best.assign.map((a) => [a.job, { shift: a.shift, mold: a.mold }]));
    for (const [jobId, cur] of [...this.state.assignment].sort()) {
      const t = target.get(jobId);
      if (!t || t.shift !== cur.shift || t.mold !== cur.mold) {
        changes.push({ type: 'unassign', jobId });
      }
    }
    for (const [jobId, t] of [...target].sort()) {
      const cur = this.state.assignment.get(jobId);
      if (!cur || cur.shift !== t.shift || cur.mold !== t.mold) {
        changes.push({ type: 'assign', jobId, shift: t.shift, mold: t.mold });
      }
    }
    if (changes.length > 0) this.applyBatch(changes, { lockedMolds });
    return {
      feasible: this.state.feasible,
      cost: best.cost,
      certificate: this.state.certificate,
      pending: this.state.pending,
    };
  }

  rollback() {
    try {
      const batch = rollbackLastBatch(this.state);
      recomputeFull(this.state);
      this.store.journal.append({ type: 'rollback', batch: batch.id });
      this.store.commitPlan(this.state);
      this.store.commitManifest(this.manifest());
      return { rolledBack: batch.id, feasible: this.state.feasible };
    } catch (err) {
      if (err instanceof MoldPlanError && err.code === 'ROLLBACK') {
        recomputeFull(this.state);
        this.store.commitPlan(this.state);
      }
      throw err;
    }
  }

  status() {
    return {
      feasible: this.state.feasible,
      pending: this.state.pending,
      certificate: this.state.certificate,
      shiftLoad: [...this.state.shiftLoad],
      budgets: this.state.calendar.shifts.map((s) => s.budget),
      usage: Object.fromEntries([...this.state.usage].sort()),
      vector: { ...this.vector },
      batches: this.state.batches.map((b) => b.id),
    };
  }

  verify() {
    const problems = [];
    const s = this.state;
    for (const [jobId, a] of s.assignment) {
      const job = s.jobs.get(jobId);
      if (!job) problems.push(`assigned unknown job ${jobId}`);
      else if (!job.eligible.includes(a.mold)) problems.push(`job ${jobId} on ineligible mold ${a.mold}`);
    }
    for (let i = 0; i < s.calendar.shifts.length; i++) {
      if (s.shiftLoad[i] > s.calendar.shifts[i].budget) {
        problems.push(`shift ${i} over budget: ${s.shiftLoad[i]} > ${s.calendar.shifts[i].budget}`);
      }
    }
    for (const p of s.pending) {
      problems.push(`mold ${p.mold} over-allocated: ${p.used} > ${p.life} (pending)`);
    }
    return { ok: problems.length === 0, problems, feasible: s.feasible };
  }

  exportOps(since = {}) {
    const records = [];
    for (const rec of this.allJournalRecords()) {
      if (rec.type !== 'batch') continue;
      const { terminal, seq } = rec.origin;
      if ((since[terminal] ?? 0) < seq) records.push(rec);
    }
    return { vector: { ...this.vector }, records };
  }

  allJournalRecords() {
    // current in-memory batches are the source of truth (journal is a prefix)
    const records = [];
    for (const b of this.state.batches) {
      records.push({
        type: 'batch',
        id: b.id,
        origin: b.origin ?? { terminal: this.terminalId, seq: b.seq },
        lockedMolds: b.lockedMolds,
        changes: b.changes.map((c) => {
          const { inverse, seq, ...rest } = c;
          void inverse;
          void seq;
          return rest;
        }),
      });
    }
    return records;
  }

  close() {
    this.store.close();
  }
}

export function toJSON(state) {
  return stateToJSON(state);
}
