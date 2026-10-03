// Core in-memory scheduling engine.
//
// Semantics:
// - Membership: join / leave / quarantine. Quarantined members keep their
//   history and existing leases but may not claim new tasks. Left members
//   may not claim; their unfinished granted tasks enter the takeover set.
// - Claims carry a fencing epoch and a vector clock. Per task, the engine
//   keeps the causal frontier of accepted claims.
//   * epoch < task max epoch            -> "stale" (fencing violation)
//   * claim concurrent with frontier    -> task becomes "pending" (never an
//     error); any live lease is revoked because the grant was made without
//     causal knowledge of this competitor.
//   * claim causally dominated          -> "superseded"
//   * claim dominates the frontier      -> granted, unless a live lease held
//     by another member blocks it ("blocked-lease"); a takeover requires the
//     previous lease to be expired at the claim's timestamp.
// - A grant is therefore only causally safe when the winning claim dominates
//   every competing claim ever seen for the task.

import { compare, clocksEqual } from './clock.js';

export const DEFAULT_TTL = 30000;

export class Engine {
  constructor() {
    this.members = new Map(); // agv -> { status: 'active'|'left'|'quarantined', since }
    this.tasks = new Map(); // task -> task state
    this.now = 0;
    this.staleClaims = 0;
  }

  ensureTask(id) {
    let task = this.tasks.get(id);
    if (!task) {
      task = {
        id,
        frontier: [],
        holder: null,
        epoch: 0,
        leaseExpiry: 0,
        leaseStatus: 'none', // none | active | revoked | completed
        status: 'open', // open | granted | pending | completed
        completed: false,
        contested: false,
      };
      this.tasks.set(id, task);
    }
    return task;
  }

  leaseRecord(task, status) {
    const holderClaim = task.frontier.find((c) => c.agv === task.holder);
    return {
      task: task.id,
      holder: task.holder,
      epoch: task.epoch,
      expiry: task.leaseExpiry,
      status,
      clock: holderClaim ? holderClaim.clock : {},
    };
  }

  applyEvent(ev) {
    if (!ev || typeof ev !== 'object' || typeof ev.type !== 'string') {
      return { decision: 'rejected', reason: 'malformed' };
    }
    if (typeof ev.ts === 'number' && Number.isFinite(ev.ts)) {
      this.now = Math.max(this.now, ev.ts);
    }
    switch (ev.type) {
      case 'join':
        return this.#join(ev);
      case 'leave':
        return this.#leave(ev);
      case 'quarantine':
        return this.#quarantine(ev);
      case 'claim':
        return this.#claim(ev);
      case 'complete':
        return this.#complete(ev);
      case 'tick':
        return { decision: 'tick', now: this.now };
      default:
        return { decision: 'ignored', reason: 'unknown-type' };
    }
  }

  #join(ev) {
    const member = this.members.get(ev.agv);
    if (member && member.status === 'active') {
      return { decision: 'duplicate', agv: ev.agv };
    }
    // Re-join after leave, or release from quarantine.
    this.members.set(ev.agv, { status: 'active', since: ev.ts ?? 0 });
    return { decision: 'joined', agv: ev.agv, journal: true };
  }

  #leave(ev) {
    const member = this.members.get(ev.agv);
    if (!member) return { decision: 'rejected', reason: 'not-member', agv: ev.agv };
    member.status = 'left';
    member.since = ev.ts ?? 0;
    return { decision: 'left', agv: ev.agv, journal: true };
  }

  #quarantine(ev) {
    const member = this.members.get(ev.agv);
    if (!member) return { decision: 'rejected', reason: 'not-member', agv: ev.agv };
    member.status = 'quarantined';
    member.since = ev.ts ?? 0;
    return { decision: 'quarantined', agv: ev.agv, journal: true };
  }

  #claim(ev) {
    const task = this.ensureTask(ev.task);
    const member = this.members.get(ev.agv);
    if (!member || member.status === 'left') {
      return { decision: 'rejected', reason: 'not-member', task: ev.task, agv: ev.agv };
    }
    if (member.status === 'quarantined') {
      return { decision: 'rejected', reason: 'quarantined', task: ev.task, agv: ev.agv };
    }
    if (task.completed) {
      return { decision: 'rejected', reason: 'completed', task: ev.task, agv: ev.agv };
    }
    const epoch = ev.epoch ?? 1;
    const ts = ev.ts ?? 0;
    const clock = ev.clock ?? { [ev.agv]: epoch };

    const duplicate = task.frontier.some(
      (c) => c.agv === ev.agv && c.epoch === epoch && clocksEqual(c.clock, clock),
    );
    if (duplicate) return { decision: 'duplicate', task: ev.task, agv: ev.agv };

    // Fencing: a lower epoch than the max ever seen for this task is rejected.
    if (epoch < task.epoch) {
      this.staleClaims += 1;
      return { decision: 'stale', task: ev.task, agv: ev.agv, epoch, taskEpoch: task.epoch };
    }

    const relations = task.frontier.map((f) => ({ f, rel: compare(clock, f.clock) }));
    const conflicts = relations.filter((r) => r.rel === 'concurrent' || r.rel === 'equal');

    if (conflicts.length > 0) {
      // Incomparable claims: keep the task pending, never fail. A live lease
      // granted without causal knowledge of this competitor is revoked.
      const claim = { agv: ev.agv, epoch, clock, ts };
      task.frontier = task.frontier.filter((f) => compare(clock, f.clock) !== 'after');
      task.frontier.push(claim);
      task.epoch = Math.max(task.epoch, epoch);
      task.contested = true;
      let lease = null;
      if (task.leaseStatus === 'active') {
        task.leaseStatus = 'revoked';
        lease = this.leaseRecord(task, 'revoked');
      }
      task.holder = null;
      task.status = 'pending';
      return {
        decision: 'pending',
        task: ev.task,
        agv: ev.agv,
        conflictsWith: conflicts.map((c) => c.f.agv),
        lease,
        journal: true,
      };
    }

    if (relations.some((r) => r.rel === 'before')) {
      // Causally older than an existing frontier claim: nothing to do.
      return { decision: 'superseded', task: ev.task, agv: ev.agv };
    }

    // The claim dominates every frontier claim (or is the first one).
    if (task.leaseStatus === 'active' && task.holder !== ev.agv && ts < task.leaseExpiry) {
      return {
        decision: 'blocked-lease',
        task: ev.task,
        agv: ev.agv,
        holder: task.holder,
        leaseExpiry: task.leaseExpiry,
      };
    }

    const claim = { agv: ev.agv, epoch, clock, ts };
    task.frontier = [claim];
    task.epoch = Math.max(task.epoch, epoch);
    task.holder = ev.agv;
    task.leaseExpiry = ts + (ev.ttl ?? DEFAULT_TTL);
    task.leaseStatus = 'active';
    task.status = 'granted';
    task.contested = false;
    return {
      decision: 'granted',
      task: ev.task,
      agv: ev.agv,
      epoch: task.epoch,
      expiry: task.leaseExpiry,
      lease: this.leaseRecord(task, 'active'),
      journal: true,
    };
  }

  #complete(ev) {
    const task = this.tasks.get(ev.task);
    if (!task || task.holder !== ev.agv || task.leaseStatus !== 'active') {
      return { decision: 'rejected', reason: 'not-holder', task: ev.task, agv: ev.agv };
    }
    const epoch = ev.epoch ?? task.epoch;
    if (epoch < task.epoch) {
      // Zombie holder fenced by a newer epoch.
      return { decision: 'stale-complete', task: ev.task, agv: ev.agv, epoch, taskEpoch: task.epoch };
    }
    task.completed = true;
    task.status = 'completed';
    task.leaseStatus = 'completed';
    return {
      decision: 'completed',
      task: ev.task,
      agv: ev.agv,
      lease: this.leaseRecord(task, 'completed'),
      journal: true,
    };
  }

  // Used by recovery when a committed lease exists that the journal missed
  // (crash after rename, before journal append).
  applyLeaseRecord(rec) {
    const task = this.ensureTask(rec.task);
    task.epoch = Math.max(task.epoch, rec.epoch);
    task.leaseExpiry = rec.expiry;
    task.leaseStatus = rec.status;
    if (rec.status === 'active') {
      task.holder = rec.holder;
      task.status = 'granted';
      task.frontier = [{ agv: rec.holder, epoch: rec.epoch, clock: rec.clock ?? {}, ts: rec.ts ?? 0 }];
    } else if (rec.status === 'revoked') {
      task.holder = null;
      task.status = 'pending';
      task.contested = true;
    } else if (rec.status === 'completed') {
      task.holder = rec.holder;
      task.status = 'completed';
      task.completed = true;
    }
  }

  summary() {
    const tasks = {};
    const takeoverSet = [];
    for (const id of [...this.tasks.keys()].sort()) {
      const task = this.tasks.get(id);
      tasks[id] = {
        status: task.status,
        holder: task.holder,
        epoch: task.epoch,
        leaseExpiry: task.leaseExpiry,
        leaseStatus: task.leaseStatus,
        leaseExpired: this.now >= task.leaseExpiry,
        contested: task.contested,
        frontier: task.frontier.map((c) => ({ agv: c.agv, epoch: c.epoch, clock: c.clock })),
      };
      if (!task.completed && task.holder && task.leaseStatus === 'active') {
        const member = this.members.get(task.holder);
        if (member && member.status === 'left') takeoverSet.push(id);
      }
    }
    const members = {};
    for (const [id, member] of [...this.members.entries()].sort()) {
      members[id] = member.status;
    }
    return {
      type: 'summary',
      now: this.now,
      members,
      tasks,
      takeoverSet: takeoverSet.sort(),
      staleClaims: this.staleClaims,
    };
  }
}
