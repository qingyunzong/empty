"use strict";

const DEFAULT_CONFIG = Object.freeze({
  channels: 2,      // parallel instrument channels
  plateWells: 384,  // wells per plate
  wellVolume: 10,   // uL per well
  cooldown: 5,      // time units for any temperature switch on a channel
  maxTempDelta: 40, // max allowed temp jump between consecutive segments
  initialTemp: 25,  // channel temperature at time 0
  costPerUnit: 1,   // budget units per uL of reagent
});

// Deterministic event-driven scheduler. Time is discrete; all decisions are
// a pure function of (state, op stream), so replays produce identical output.
class Scheduler {
  constructor(config = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.now = 0;
    this.channels = [];
    for (let i = 0; i < this.config.channels; i++) {
      this.channels.push({
        id: i,
        temp: this.config.initialTemp,
        state: "idle", // idle | cooling | running
        task: null,
        endsAt: 0,
        coolTo: null,
        pendingResume: false,
        timeline: [],
      });
    }
    this.tasks = new Map();
    this.budgets = new Map(); // project -> number (absent means unlimited)
    this.events = [];
    this.reservedWells = 0;
    this.projectList = []; // sorted, for round-robin
    this.lastServedProject = null; // round-robin cursor
    this.makespan = 0;
    this._drained = 0; // events index consumed by the engine (contamination)
  }

  costOf(task) {
    return task.volume * this.config.costPerUnit;
  }

  budgetOf(project) {
    return this.budgets.has(project) ? this.budgets.get(project) : Infinity;
  }

  setBudget(project, value) {
    this.budgets.set(project, value);
  }

  // Deficit rule: a project short on budget may not start new tasks, but
  // tasks already in a critical (executing) segment are never killed.
  eligible(task) {
    return this.budgetOf(task.project) >= this.costOf(task);
  }

  waiting() {
    const out = [];
    for (const task of this.tasks.values()) {
      if (task.status === "waiting" || task.status === "paused") out.push(task);
    }
    return out;
  }

  rrRank(project) {
    const n = this.projectList.length;
    if (n === 0) return 0;
    const idx = this.projectList.indexOf(project);
    const last = this.projectList.indexOf(this.lastServedProject);
    if (last === -1) return idx;
    return (((idx - last - 1) % n) + n) % n;
  }

  // Fairness: priority desc, wait aging (older first), project round-robin,
  // task id as final tie-break.
  compare(a, b) {
    if (a.priority !== b.priority) return b.priority - a.priority;
    if (a.enqueueTime !== b.enqueueTime) return a.enqueueTime - b.enqueueTime;
    const ra = this.rrRank(a.project);
    const rb = this.rrRank(b.project);
    if (ra !== rb) return ra - rb;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  }

  waitingOrder() {
    return this.waiting().sort((a, b) => this.compare(a, b)).map((t) => t.id);
  }

  addTask(task) {
    this.tasks.set(task.id, task);
    this.reservedWells += task.wells;
    if (!this.projectList.includes(task.project)) {
      this.projectList.push(task.project);
      this.projectList.sort();
    }
  }

  removeTask(id) {
    const task = this.tasks.get(id);
    if (!task) return;
    this.tasks.delete(id);
    this.reservedWells -= task.wells;
    this.events.push({ time: this.now, type: "abort", taskId: id });
  }

  pickChannel(free, temp) {
    const matching = free.filter((c) => c.temp === temp);
    const pool = matching.length ? matching : free;
    pool.sort((a, b) => a.id - b.id);
    return pool[0];
  }

  assign(ch, task) {
    if (!task.charged) {
      const cost = this.costOf(task);
      const budget = this.budgetOf(task.project);
      if (budget !== Infinity) this.budgets.set(task.project, budget - cost);
      task.charged = true;
      this.events.push({
        time: this.now,
        type: "charge",
        project: task.project,
        taskId: task.id,
        amount: cost,
      });
    }
    const resumed = task.status === "paused";
    task.status = "running";
    ch.task = task;
    const seg = task.segments[task.segIndex];
    if (ch.temp !== seg.temp) {
      ch.state = "cooling";
      ch.coolTo = seg.temp;
      ch.endsAt = this.now + this.config.cooldown;
      ch.pendingResume = resumed;
      ch.timeline.push({
        type: "cooldown",
        from: ch.temp,
        to: seg.temp,
        start: this.now,
        end: ch.endsAt,
      });
    } else {
      this.startSegment(ch, task, resumed);
    }
  }

  startSegment(ch, task, resumed) {
    const seg = task.segments[task.segIndex];
    ch.state = "running";
    ch.endsAt = this.now + seg.duration;
    ch.timeline.push({
      type: "run",
      taskId: task.id,
      segment: task.segIndex,
      temp: seg.temp,
      start: this.now,
      end: ch.endsAt,
    });
    if (!task.everStarted) {
      task.everStarted = true;
      this.events.push({ time: this.now, type: "start", taskId: task.id, channel: ch.id });
    } else if (resumed) {
      this.events.push({
        time: this.now,
        type: "resume",
        taskId: task.id,
        channel: ch.id,
        segment: task.segIndex,
      });
    }
  }

  // Advance one channel whose current activity ends exactly at this.now.
  advance(ch) {
    const task = ch.task;
    if (ch.state === "cooling") {
      ch.temp = ch.coolTo;
      ch.coolTo = null;
      const resumed = ch.pendingResume;
      ch.pendingResume = false;
      this.startSegment(ch, task, resumed);
      return;
    }
    // A running segment finished: we are at a temperature-segment boundary.
    task.segIndex += 1;
    const doneSeg = task.segments[task.segIndex - 1];
    ch.temp = doneSeg.temp;
    if (task.abortPending) {
      task.status = "aborted";
      this.reservedWells -= task.wells;
      this.events.push({ time: this.now, type: "abort", taskId: task.id });
      // Wells touched by an aborted run are confirmed contaminated.
      this.events.push({ time: this.now, type: "contaminate", taskId: task.id, wells: task.wells });
      ch.task = null;
      ch.state = "idle";
    } else if (task.preemptMarked) {
      // Preemption takes effect only here, at the segment boundary; the
      // completed segments are saved and the task can resume later.
      task.preemptMarked = false;
      task.status = "paused";
      this.events.push({ time: this.now, type: "preempt", taskId: task.id, atSegment: task.segIndex });
      ch.task = null;
      ch.state = "idle";
    } else if (task.segIndex < task.segments.length) {
      const next = task.segments[task.segIndex];
      if (next.temp !== ch.temp) {
        ch.state = "cooling";
        ch.coolTo = next.temp;
        ch.endsAt = this.now + this.config.cooldown;
        ch.timeline.push({
          type: "cooldown",
          from: ch.temp,
          to: next.temp,
          start: this.now,
          end: ch.endsAt,
        });
      } else {
        this.startSegment(ch, task, false);
      }
    } else {
      task.status = "done";
      task.completedAt = this.now;
      this.reservedWells -= task.wells;
      this.makespan = Math.max(this.makespan, this.now);
      this.events.push({ time: this.now, type: "complete", taskId: task.id });
      ch.task = null;
      ch.state = "idle";
    }
  }

  // Fill free channels from the queue, then mark preemptions for
  // higher-priority waiters (effective at the next segment boundary).
  evaluate() {
    for (;;) {
      const free = this.channels.filter((c) => c.state === "idle");
      if (!free.length) break;
      const candidates = this.waiting().filter((t) => this.eligible(t));
      if (!candidates.length) break;
      candidates.sort((a, b) => this.compare(a, b));
      const task = candidates[0];
      const ch = this.pickChannel(free, task.segments[task.segIndex].temp);
      this.assign(ch, task);
      this.lastServedProject = task.project;
    }
    for (;;) {
      const waiters = this.waiting().filter((t) => this.eligible(t));
      waiters.sort((a, b) => this.compare(a, b));
      let marked = false;
      for (const w of waiters) {
        const victims = this.channels.filter(
          (c) =>
            c.state === "running" &&
            c.task &&
            !c.task.preemptMarked &&
            !c.task.abortPending &&
            c.task.priority < w.priority
        );
        if (victims.length) {
          victims.sort((a, b) => {
            if (a.task.priority !== b.task.priority) return a.task.priority - b.task.priority;
            return a.task.id < b.task.id ? -1 : 1;
          });
          victims[0].task.preemptMarked = true;
          marked = true;
          break;
        }
      }
      if (!marked) break;
    }
  }

  nextEventTime() {
    let next = Infinity;
    for (const ch of this.channels) {
      if (ch.state !== "idle" && ch.endsAt < next) next = ch.endsAt;
    }
    return next;
  }

  runUntil(target) {
    const limit = Math.max(target, this.now);
    this.evaluate();
    for (;;) {
      const next = this.nextEventTime();
      if (next === Infinity || next > limit) break;
      this.now = next;
      for (const ch of this.channels) {
        if (ch.state !== "idle" && ch.endsAt === this.now) this.advance(ch);
      }
      this.evaluate();
    }
    this.now = limit;
  }

  finish() {
    this.evaluate();
    for (;;) {
      const next = this.nextEventTime();
      if (next === Infinity) break;
      this.now = next;
      for (const ch of this.channels) {
        if (ch.state !== "idle" && ch.endsAt === this.now) this.advance(ch);
      }
      this.evaluate();
    }
  }
}

module.exports = { Scheduler, DEFAULT_CONFIG };
