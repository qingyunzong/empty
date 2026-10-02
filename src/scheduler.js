import { compare, merge, BEFORE, CONCURRENT } from './vclock.js';

export class Scheduler {
  constructor() {
    this.members = new Map();
    this.tasks = new Map();
    this.decisions = [];
    this.seq = 0;
  }

  #member(id) {
    let m = this.members.get(id);
    if (!m) {
      m = { agv: id, status: 'unknown', history: [] };
      this.members.set(id, m);
    }
    return m;
  }

  #task(id) {
    let t = this.tasks.get(id);
    if (!t) {
      t = {
        task: id,
        status: 'pending',
        owner: null,
        fencingEpoch: 0,
        leaseStart: 0,
        leaseExpiry: 0,
        claimVc: null,
        contested: false,
        contenders: [],
        takeoverEligible: false,
        history: [],
      };
      this.tasks.set(id, t);
    }
    return t;
  }

  #record(e, result, reason = null, extra = null) {
    const d = {
      type: 'decision',
      seq: this.seq,
      event: e.type,
      task: e.task ?? null,
      agv: e.agv ?? null,
      time: e.time ?? null,
      result,
    };
    if (reason) d.reason = reason;
    if (extra) Object.assign(d, extra);
    this.decisions.push(d);
    return d;
  }

  apply(e) {
    this.seq += 1;
    switch (e.type) {
      case 'join': {
        const m = this.#member(e.agv);
        m.status = 'active';
        m.history.push({ time: e.time ?? null, to: 'active' });
        return this.#record(e, 'joined');
      }
      case 'leave': {
        const m = this.#member(e.agv);
        m.status = 'left';
        m.history.push({ time: e.time ?? null, to: 'left' });
        for (const t of this.tasks.values()) {
          if (t.status === 'claimed' && t.owner === e.agv) {
            t.owner = null;
            t.status = 'pending';
            t.takeoverEligible = true;
            t.leaseExpiry = e.time ?? 0;
            t.claimVc = null;
            t.history.push({ agv: e.agv, time: e.time ?? null, result: 'released-on-leave' });
          }
        }
        return this.#record(e, 'left');
      }
      case 'quarantine': {
        const m = this.#member(e.agv);
        m.status = 'quarantined';
        m.history.push({ time: e.time ?? null, to: 'quarantined' });
        return this.#record(e, 'quarantined');
      }
      case 'release': {
        const m = this.#member(e.agv);
        m.status = 'active';
        m.history.push({ time: e.time ?? null, to: 'active' });
        return this.#record(e, 'released');
      }
      case 'task': {
        this.#task(e.task);
        return this.#record(e, 'registered');
      }
      case 'claim':
        return this.#claim(e);
      case 'complete':
        return this.#complete(e);
      default:
        return this.#record(e, 'ignored', 'unknown-event');
    }
  }

  #claim(e) {
    const t = this.#task(e.task);
    const m = this.members.get(e.agv);
    const reject = (reason) => this.#record(e, 'rejected', reason, { epoch: e.epoch ?? null });
    if (!m || m.status !== 'active') {
      return reject(m && m.status === 'quarantined' ? 'quarantined' : 'not-member');
    }
    if (t.status === 'completed') return reject('completed');

    if (t.status === 'claimed') {
      if (t.owner === e.agv) {
        if ((e.epoch ?? 0) < t.fencingEpoch) return reject('stale-epoch');
        t.leaseStart = e.time ?? 0;
        t.leaseExpiry = (e.time ?? 0) + (e.leaseMs ?? 0);
        t.fencingEpoch = Math.max(t.fencingEpoch, e.epoch ?? 0);
        t.claimVc = merge(t.claimVc ?? {}, e.vc ?? {});
        t.history.push({ agv: e.agv, epoch: e.epoch, time: e.time ?? null, result: 'renewed' });
        return this.#record(e, 'renewed', null, { epoch: e.epoch, leaseExpiry: t.leaseExpiry });
      }
      const rel = compare(t.claimVc ?? {}, e.vc ?? {});
      if (rel === CONCURRENT) {
        // Causally incomparable claims: keep the task pending instead of failing.
        t.contenders.push({ agv: t.owner, vc: t.claimVc }, { agv: e.agv, vc: e.vc ?? {} });
        t.owner = null;
        t.status = 'pending';
        t.contested = true;
        t.claimVc = null;
        t.leaseExpiry = 0;
        return this.#record(e, 'contested', null, { epoch: e.epoch ?? null });
      }
      if (rel === BEFORE) {
        if ((e.time ?? 0) > t.leaseExpiry) {
          if ((e.epoch ?? 0) <= t.fencingEpoch) return reject('stale-epoch');
          return this.#grant(t, e, 'takeover');
        }
        return reject('held');
      }
      return reject('superseded');
    }

    // pending: fresh, contested, or takeover-eligible after leave
    if (t.contested) {
      const afterAll = t.contenders.every((c) => compare(c.vc, e.vc ?? {}) === BEFORE);
      if (!afterAll) {
        t.contenders.push({ agv: e.agv, vc: e.vc ?? {} });
        return this.#record(e, 'contested', null, { epoch: e.epoch ?? null });
      }
    }
    if ((e.epoch ?? 0) <= t.fencingEpoch) return reject('stale-epoch');
    return this.#grant(t, e, t.takeoverEligible ? 'takeover' : 'granted');
  }

  #grant(t, e, result) {
    t.status = 'claimed';
    t.owner = e.agv;
    t.fencingEpoch = e.epoch ?? 0;
    t.leaseStart = e.time ?? 0;
    t.leaseExpiry = (e.time ?? 0) + (e.leaseMs ?? 0);
    t.claimVc = e.vc ?? {};
    t.contested = false;
    t.contenders = [];
    t.takeoverEligible = false;
    t.history.push({ agv: e.agv, epoch: e.epoch, time: e.time ?? null, result });
    return this.#record(e, result, null, { epoch: e.epoch ?? null, leaseExpiry: t.leaseExpiry });
  }

  #complete(e) {
    const t = this.#task(e.task);
    const reject = (reason) => this.#record(e, 'rejected', reason);
    if (t.status !== 'claimed' || t.owner !== e.agv) return reject('not-owner');
    if ((e.time ?? 0) > t.leaseExpiry) return reject('lease-expired');
    t.status = 'completed';
    t.completedBy = e.agv;
    t.completedAt = e.time ?? null;
    t.history.push({ agv: e.agv, time: e.time ?? null, result: 'completed' });
    return this.#record(e, 'completed');
  }

  snapshot() {
    const byId = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
    const tasks = [...this.tasks.values()].sort((x, y) => byId(x.task, y.task)).map((t) => ({
      type: 'task',
      task: t.task,
      status: t.status,
      owner: t.owner,
      contested: t.contested,
      takeoverEligible: t.takeoverEligible,
      fencingEpoch: t.fencingEpoch,
      leaseExpiry: t.leaseExpiry,
    }));
    const members = [...this.members.values()].sort((x, y) => byId(x.agv, y.agv)).map((m) => ({
      type: 'member',
      agv: m.agv,
      status: m.status,
    }));
    const count = (pred) => tasks.filter(pred).length;
    const summary = {
      type: 'summary',
      tasks: tasks.length,
      claimed: count((t) => t.status === 'claimed'),
      pending: count((t) => t.status === 'pending'),
      completed: count((t) => t.status === 'completed'),
      contested: count((t) => t.contested),
      takeoverSet: tasks.filter((t) => t.takeoverEligible).map((t) => t.task),
    };
    return { tasks, members, summary };
  }
}

export function replay(events) {
  const s = new Scheduler();
  for (const e of events) s.apply(e);
  return s;
}
