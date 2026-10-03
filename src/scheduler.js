import { CODES } from './errors.js';

// Fair scheduler with bounded buffer, per-tenant quotas and aging.
//
// - Rate quota: token bucket per tenant (capacity = ratePerSec, i.e. 1s burst),
//   refilled in virtual time; the virtual clock only advances when every
//   backlogged tenant is out of tokens, so scheduling is fully deterministic.
// - Disk quota: hard per-tenant byte cap. An event that would exceed it is
//   rejected with a QUOTA violation; the hard cap is never crossed.
// - Aging: a tenant's score is basePriority + agingRate * (rounds since it was
//   last served). Waiting tenants monotonically gain priority, so with a
//   bounded buffer starvation is bounded: a backlogged tenant is served within
//   ceil((maxPriority - itsPriority) / agingRate) + 1 rounds.
export class FairScheduler {
  constructor({
    quotas = {},
    priorities = {},
    capacity = 4096,
    agingRate = 1,
    sizeOf = null,
  } = {}) {
    this.quotas = quotas;
    this.priorities = priorities;
    this.capacity = capacity;
    this.agingRate = agingRate;
    this.sizeOf = sizeOf ?? ((event) => Buffer.byteLength(JSON.stringify(event)) + 1);
    this.tenants = new Map();
    this.queuedCount = 0;
    this.round = 0;
    this.nowMs = 0;
    this.violations = [];
  }

  _tenant(name) {
    let st = this.tenants.get(name);
    if (!st) {
      const rate = this.quotas[name]?.ratePerSec;
      st = {
        queue: [],
        tokens: rate == null ? Infinity : rate,
        usedBytes: 0,
        lastServed: -1,
        lastRefillMs: 0,
      };
      this.tenants.set(name, st);
    }
    return st;
  }

  setUsedBytes(name, bytes) {
    this._tenant(name).usedBytes = bytes;
  }

  _refill(name, st) {
    const rate = this.quotas[name]?.ratePerSec;
    if (rate == null) return;
    const elapsed = this.nowMs - st.lastRefillMs;
    if (elapsed > 0) {
      st.tokens = Math.min(rate, st.tokens + (rate * elapsed) / 1000);
      st.lastRefillMs = this.nowMs;
    }
  }

  // Admits events in fair order. Returns { admitted, violations } where each
  // admitted record is { event, round, timeMs, size }.
  run(events) {
    const admitted = [];
    let i = 0;
    while (i < events.length || this.queuedCount > 0) {
      while (i < events.length && this.queuedCount < this.capacity) {
        const st = this._tenant(events[i].tenant);
        st.queue.push(events[i]);
        this.queuedCount++;
        i++;
      }
      const rec = this._dispatchOne(admitted.length);
      if (!rec) break;
      admitted.push(rec);
    }
    return { admitted, violations: this.violations };
  }

  _dispatchOne(admissionIndex) {
    for (;;) {
      // Reject head events that would break the hard disk quota.
      let rejected = false;
      for (const [name, st] of this.tenants) {
        const quota = this.quotas[name];
        while (st.queue.length > 0) {
          const size = this.sizeOf(st.queue[0], admissionIndex);
          if (quota?.diskBytes != null && st.usedBytes + size > quota.diskBytes) {
            this.violations.push({
              code: CODES.QUOTA,
              tenant: name,
              detail: `disk quota exceeded: ${st.usedBytes}+${size} > ${quota.diskBytes}`,
              event: st.queue.shift(),
            });
            this.queuedCount--;
            rejected = true;
          } else if (quota?.ratePerSec === 0) {
            this.violations.push({
              code: CODES.QUOTA,
              tenant: name,
              detail: 'rate quota is 0',
              event: st.queue.shift(),
            });
            this.queuedCount--;
            rejected = true;
          } else {
            break;
          }
        }
      }
      if (rejected) continue;

      let anyQueued = false;
      const eligible = [];
      for (const [name, st] of this.tenants) {
        if (st.queue.length === 0) continue;
        anyQueued = true;
        this._refill(name, st);
        if (st.tokens >= 1) eligible.push([name, st]);
      }
      if (!anyQueued) return null;

      if (eligible.length === 0) {
        // Advance virtual time to the earliest next token.
        let dt = Infinity;
        for (const [name, st] of this.tenants) {
          if (st.queue.length === 0) continue;
          const rate = this.quotas[name]?.ratePerSec;
          if (rate == null || rate <= 0) continue;
          dt = Math.min(dt, ((1 - st.tokens) / rate) * 1000);
        }
        this.nowMs += dt;
        continue;
      }

      // Pick the eligible tenant with the highest aged score.
      let bestName = null;
      let bestState = null;
      let bestScore = -Infinity;
      for (const [name, st] of eligible) {
        const wait = this.round - st.lastServed;
        const score = (this.priorities[name] ?? 0) + this.agingRate * wait;
        if (score > bestScore || (score === bestScore && name < bestName)) {
          bestName = name;
          bestState = st;
          bestScore = score;
        }
      }
      const event = bestState.queue.shift();
      this.queuedCount--;
      const size = this.sizeOf(event, admissionIndex);
      bestState.tokens -= 1;
      bestState.usedBytes += size;
      bestState.lastServed = this.round;
      const rec = { event, round: this.round, timeMs: this.nowMs, size };
      this.round++;
      return rec;
    }
  }
}
