// Weighted fair scheduler with token-bucket rate quotas and aging.
//
// - Each tenant has a token bucket refilled at `ratePerSec` (records/sec, hard rate quota).
// - Effective weight = baseWeight + ageSeconds * agingFactor: the longer the head
//   record waits, the more its tenant is favoured. Because the aging term is
//   additive, any waiting tenant eventually overtakes every fixed competitor,
//   which bounds starvation.
// - Aging only reorders dispatch among *eligible* tenants; it can never create tokens
//   or override a hard quota.
export class Scheduler {
  constructor({ quotas = {}, agingFactor = 1, quantumMs = 5, now = 0 } = {}) {
    this.quotas = quotas;
    this.agingFactor = agingFactor;
    this.quantumMs = quantumMs;
    this.now = now;
    this.pending = new Map(); // tenant -> [item]
    this.tokens = new Map(); // tenant -> tokens
    this.lastRefill = new Map(); // tenant -> ms
    this.lastDispatch = new Map(); // tenant -> ms
  }

  _quota(tenant) {
    return this.quotas[tenant] ?? {};
  }

  _rate(tenant) {
    return this._quota(tenant).ratePerSec ?? Infinity;
  }

  _baseWeight(tenant) {
    return this._quota(tenant).weight ?? 1;
  }

  _refill(tenant) {
    const rate = this._rate(tenant);
    if (!Number.isFinite(rate)) {
      this.tokens.set(tenant, Infinity);
      this.lastRefill.set(tenant, this.now);
      return;
    }
    const last = this.lastRefill.get(tenant) ?? this.now;
    const current = this.tokens.get(tenant) ?? rate; // buckets start full
    const next = Math.min(rate, current + (rate * (this.now - last)) / 1000);
    this.tokens.set(tenant, next);
    this.lastRefill.set(tenant, this.now);
  }

  enqueue(item) {
    const entry = { ...item, enqueuedAt: this.now };
    if (!this.pending.has(item.tenant)) this.pending.set(item.tenant, []);
    this.pending.get(item.tenant).push(entry);
    return entry;
  }

  get size() {
    let n = 0;
    for (const q of this.pending.values()) n += q.length;
    return n;
  }

  pendingOf(tenant) {
    return this.pending.get(tenant)?.length ?? 0;
  }

  _eligible(tenant) {
    if (!this.pendingOf(tenant)) return false;
    this._refill(tenant);
    return this.tokens.get(tenant) >= 1;
  }

  _agedWeight(tenant) {
    // Age is measured since the tenant was last served (or since its head
    // record arrived): being dispatched resets the aging clock, so a waiting
    // tenant's weight grows relative to competitors that are being served.
    const since = this.lastDispatch.get(tenant) ?? this.pending.get(tenant)[0].enqueuedAt;
    const ageSeconds = (this.now - since) / 1000;
    return this._baseWeight(tenant) + ageSeconds * this.agingFactor;
  }

  // Theoretical upper bound (ms) for how long a tenant's head record can wait
  // while competitors keep winning: the age at which its aged weight overtakes
  // the largest competitor base weight, plus one dispatch quantum.
  starvationBoundMs(tenant) {
    let maxOther = 0;
    for (const t of this.pending.keys()) {
      if (t !== tenant && this.pendingOf(t)) maxOther = Math.max(maxOther, this._baseWeight(t));
    }
    const base = this._baseWeight(tenant);
    if (maxOther <= base) return this.quantumMs;
    if (this.agingFactor <= 0) return Infinity;
    return ((maxOther - base) * 1000) / this.agingFactor + this.quantumMs;
  }

  _advanceToNextRefill(exclude) {
    let dt = Infinity;
    let any = false;
    for (const tenant of this.pending.keys()) {
      if (exclude && exclude.has(tenant)) continue;
      if (!this.pendingOf(tenant)) continue;
      any = true;
      this._refill(tenant);
      const tokens = this.tokens.get(tenant);
      if (tokens >= 1) return true;
      const rate = this._rate(tenant);
      if (Number.isFinite(rate) && rate > 0) dt = Math.min(dt, ((1 - tokens) / rate) * 1000);
    }
    if (!any) return false;
    if (!Number.isFinite(dt)) return false; // no tenant can ever become eligible
    this.now += Math.max(dt, 1e-6);
    return true;
  }

  // Pick the eligible tenant with the highest aged weight.
  // `exclude` optionally skips tenants (e.g. blocked for the current page).
  // Ties break towards the longest-waiting head, then the least recently
  // dispatched tenant, then the tenant name (deterministic).
  _pick(exclude = null) {
    let best = null;
    let bestKey = null;
    for (const tenant of this.pending.keys()) {
      if (exclude && exclude.has(tenant)) continue;
      if (!this._eligible(tenant)) continue;
      const head = this.pending.get(tenant)[0];
      const key = [
        this._agedWeight(tenant),
        -head.enqueuedAt,
        -(this.lastDispatch.get(tenant) ?? -1),
      ];
      if (!bestKey || key[0] > bestKey[0]
        || (key[0] === bestKey[0] && (key[1] > bestKey[1]
          || (key[1] === bestKey[1] && (key[2] > bestKey[2]
            || (key[2] === bestKey[2] && tenant < best)))))) {
        bestKey = key;
        best = tenant;
      }
    }
    if (!best && this.size > 0) {
      if (!this._advanceToNextRefill(exclude)) return null;
      return this._pick(exclude);
    }
    return best;
  }

  // Look at the next item without removing it.
  peek(exclude = null) {
    const tenant = this._pick(exclude);
    if (!tenant) return null;
    return this.pending.get(tenant)[0];
  }

  // Remove and return the next item. If `exclude` is given and the picked
  // tenant is excluded, returns null (caller should peek first).
  next(exclude = null) {
    const tenant = this._pick(exclude);
    if (!tenant) return null;
    const item = this.pending.get(tenant).shift();
    this.tokens.set(tenant, this.tokens.get(tenant) - 1);
    item.dispatchedAt = this.now;
    item.waitMs = this.now - item.enqueuedAt;
    this.lastDispatch.set(tenant, this.now);
    this.now += this.quantumMs;
    return item;
  }
}
