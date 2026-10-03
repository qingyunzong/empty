"use strict";

const { LabError, CODES } = require("./errors");
const { chainHash, GENESIS } = require("./util");
const { Scheduler, DEFAULT_CONFIG } = require("./scheduler");

// Engine ties the op stream (enqueue/correct/budget/abort/undo) to the
// scheduler, the persistent contamination record, and the hash-chained log.
class Engine {
  constructor(config = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.scheduler = new Scheduler(this.config);
    this.ops = []; // applied non-undo op stack (undo pops)
    this.appliedOpIds = new Set();
    this.failures = [];
    this.skipped = [];
    // Confirmed contaminated wells per task. Lives outside the replayed
    // state: undo never resurrects a confirmed contaminated well.
    this.contamination = new Map();
    this.prevHash = GENESIS;
    this.seq = 0;
    this.journal = null;
  }

  fail(op, code, message) {
    this.failures.push({ op: op && op.op, id: op && op.id, code, message });
  }

  applyOp(op, opts = {}) {
    if (!op || typeof op.op !== "string") {
      this.failures.push({ op: null, code: "INVALID_OP", message: "missing op type" });
      return;
    }
    if (op.id !== undefined && this.appliedOpIds.has(op.id)) {
      this.skipped.push(op.id);
      return;
    }
    if (op.op === "undo") {
      const t = Number.isFinite(op.time) ? Math.max(op.time, this.scheduler.now) : this.scheduler.now;
      this.scheduler.runUntil(t);
      this.drainContamination();
      if (this.ops.length) {
        this.ops.pop();
        this.rebuild();
      } else {
        this.fail(op, "NOTHING_TO_UNDO", "operation stack is empty");
      }
    } else {
      this.ops.push(op);
      try {
        this.applyToScheduler(op);
      } catch (err) {
        this.ops.pop();
        throw err;
      }
    }
    if (op.id !== undefined) this.appliedOpIds.add(op.id);
    this.commit(op, opts);
  }

  commit(op, opts) {
    const prev = this.prevHash;
    this.prevHash = chainHash(prev, op);
    this.seq += 1;
    if (this.journal && !opts.fromJournal) {
      this.journal.append({ seq: this.seq, prev, hash: this.prevHash, op });
    }
  }

  // Hierarchical rollback: rebuild state by replaying the remaining op
  // stack from scratch. The contamination map is deliberately not reset.
  rebuild() {
    const saved = this.ops;
    this.scheduler = new Scheduler(this.config);
    this.ops = [];
    for (const op of saved) {
      this.ops.push(op);
      this.applyToScheduler(op);
    }
  }

  drainContamination() {
    const s = this.scheduler;
    for (let i = s._drained; i < s.events.length; i++) {
      const ev = s.events[i];
      if (ev.type === "contaminate") this.contamination.set(ev.taskId, ev.wells);
    }
    s._drained = s.events.length;
  }

  applyToScheduler(op) {
    const s = this.scheduler;
    const t = Number.isFinite(op.time) ? Math.max(op.time, s.now) : s.now;
    s.runUntil(t);
    switch (op.op) {
      case "enqueue":
        this.opEnqueue(op);
        break;
      case "budget":
        this.opBudget(op);
        break;
      case "correct":
        this.opCorrect(op);
        break;
      case "abort":
        this.opAbort(op);
        break;
      default:
        this.fail(op, "UNKNOWN_OP", `unknown op "${op.op}"`);
    }
    s.evaluate();
    this.drainContamination();
  }

  opEnqueue(op) {
    const s = this.scheduler;
    const tk = op.task;
    if (
      !tk ||
      typeof tk.id !== "string" ||
      typeof tk.project !== "string" ||
      !Number.isFinite(tk.volume) ||
      tk.volume <= 0 ||
      !Array.isArray(tk.segments) ||
      tk.segments.length === 0
    ) {
      this.fail(op, "INVALID_OP", "enqueue requires task {id, project, volume>0, segments[]}");
      return;
    }
    for (const seg of tk.segments) {
      if (!seg || !Number.isFinite(seg.temp) || !Number.isFinite(seg.duration) || seg.duration <= 0) {
        this.fail(op, "INVALID_OP", "segments need finite temp and duration > 0");
        return;
      }
    }
    if (s.tasks.has(tk.id)) {
      this.fail(op, "DUPLICATE_TASK", `task "${tk.id}" already exists`);
      return;
    }
    const wells = Math.ceil(tk.volume / this.config.wellVolume);
    if (wells > this.config.plateWells) {
      throw new LabError(
        CODES.VOLUME_EXCEEDS_PLATE,
        `task "${tk.id}" needs ${wells} wells, plate holds ${this.config.plateWells}`
      );
    }
    if (s.reservedWells + wells > this.config.plateWells) {
      throw new LabError(
        CODES.VOLUME_EXCEEDS_PLATE,
        `plate capacity exceeded: ${s.reservedWells}+${wells} > ${this.config.plateWells} wells`
      );
    }
    for (let i = 1; i < tk.segments.length; i++) {
      const delta = Math.abs(tk.segments[i].temp - tk.segments[i - 1].temp);
      if (delta > this.config.maxTempDelta) {
        throw new LabError(
          CODES.COOLDOWN_CONFLICT,
          `task "${tk.id}" temp jump ${delta} exceeds maxTempDelta ${this.config.maxTempDelta}`
        );
      }
    }
    s.addTask({
      id: tk.id,
      project: tk.project,
      volume: tk.volume,
      wells,
      priority: Number.isFinite(tk.priority) ? tk.priority : 0,
      segments: tk.segments.map((seg) => ({ temp: seg.temp, duration: seg.duration })),
      status: "waiting",
      segIndex: 0,
      enqueueTime: s.now,
      charged: false,
      preemptMarked: false,
      abortPending: false,
      everStarted: false,
    });
  }

  opBudget(op) {
    if (typeof op.project !== "string" || !Number.isFinite(op.set)) {
      this.fail(op, "INVALID_OP", "budget requires {project, set}");
      return;
    }
    if (op.set < 0) {
      throw new LabError(CODES.BUDGET_NEGATIVE, `budget for "${op.project}" would be ${op.set}`);
    }
    this.scheduler.setBudget(op.project, op.set);
  }

  opCorrect(op) {
    const s = this.scheduler;
    const task = s.tasks.get(op.taskId);
    if (!task || task.status === "done" || task.status === "aborted") {
      this.fail(op, "UNKNOWN_TASK", `no active task "${op.taskId}"`);
      return;
    }
    if (!Number.isFinite(op.volume) || op.volume <= 0) {
      this.fail(op, "INVALID_OP", "correct requires volume > 0");
      return;
    }
    const newWells = Math.ceil(op.volume / this.config.wellVolume);
    if (newWells > this.config.plateWells) {
      throw new LabError(
        CODES.VOLUME_EXCEEDS_PLATE,
        `corrected volume needs ${newWells} wells, plate holds ${this.config.plateWells}`
      );
    }
    if (s.reservedWells - task.wells + newWells > this.config.plateWells) {
      throw new LabError(CODES.VOLUME_EXCEEDS_PLATE, "corrected volume exceeds plate capacity");
    }
    // Feasibility recompute: adjust reserved wells and the charged amount.
    if (task.charged) {
      const budget = s.budgetOf(task.project);
      if (budget !== Infinity) {
        const next = budget - (op.volume - task.volume) * this.config.costPerUnit;
        if (next < 0) {
          throw new LabError(
            CODES.BUDGET_NEGATIVE,
            `correction would drive budget of "${task.project}" to ${next}`
          );
        }
        s.budgets.set(task.project, next);
      }
    }
    s.reservedWells += newWells - task.wells;
    task.volume = op.volume;
    task.wells = newWells;
    s.events.push({ time: s.now, type: "correct", taskId: task.id, volume: op.volume });
  }

  opAbort(op) {
    const s = this.scheduler;
    const task = s.tasks.get(op.taskId);
    if (!task) {
      this.fail(op, "UNKNOWN_TASK", `no task "${op.taskId}"`);
      return;
    }
    if (task.status === "done" || task.status === "aborted") {
      this.fail(op, "TASK_NOT_ACTIVE", `task "${op.taskId}" already ${task.status}`);
      return;
    }
    if (task.status === "waiting" || task.status === "paused") {
      s.removeTask(task.id);
    } else {
      // Running tasks stop at the next segment boundary; the wells in use
      // are confirmed contaminated when the segment completes.
      task.abortPending = true;
    }
  }

  finish() {
    this.scheduler.finish();
    this.drainContamination();
  }

  getOutput() {
    const s = this.scheduler;
    const budgets = {};
    for (const [project, value] of [...s.budgets.entries()].sort()) {
      budgets[project] = value === Infinity ? "unlimited" : value;
    }
    let contaminatedWells = 0;
    for (const wells of this.contamination.values()) contaminatedWells += wells;
    return {
      makespan: s.makespan,
      channels: s.channels.map((c) => ({ channel: c.id, blocks: c.timeline })),
      events: s.events,
      waiting: s.waitingOrder(),
      budgets,
      contaminatedWells,
      failures: this.failures,
      skipped: this.skipped,
      logRoot: this.prevHash,
    };
  }
}

module.exports = { Engine };
