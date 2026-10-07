import { QError, scopeErr, typeErr, capErr, expiredErr, noteErr } from './errors.js';
import { runRules } from './vm.js';

const DAY_START = 'T00:00:00Z';

export function eventTime(ev) {
  const t = ev.ts ?? (ev.date ? ev.date + DAY_START : null);
  const ms = Date.parse(t);
  if (Number.isNaN(ms)) throw typeErr(`event '${ev.id}' has invalid timestamp '${t}'`);
  return ms;
}

// Deterministic total order over concurrent events: timestamp first, then
// event id as a stable tie-break, so replays always agree with the original.
export function orderEvents(events) {
  return [...events].sort((a, b) => {
    const dt = eventTime(a) - eventTime(b);
    if (dt !== 0) return dt;
    const ia = String(a.id ?? '');
    const ib = String(b.id ?? '');
    return ia < ib ? -1 : ia > ib ? 1 : 0;
  });
}

export class Engine {
  constructor(policy) {
    this.policy = policy;
    this.buckets = new Map(policy.buckets.map((b) => [
      b.name, { limit: b.limit, available: b.limit, frozen: 0, used: 0 },
    ]));
    this.freezes = new Map();
    this.scopeFrozen = new Map(); // scopePath -> Map(bucket -> active remaining)
    this.log = [];
  }

  applyAll(events) {
    for (const ev of orderEvents(events)) this.apply(ev);
  }

  apply(ev) {
    try {
      const info = this.dispatch(ev);
      const entry = { event: ev, ok: true };
      if (info) entry.info = info;
      this.log.push(entry);
    } catch (e) {
      const code = e instanceof QError ? e.code : 'E_INTERNAL';
      this.log.push({ event: ev, ok: false, error: { code, message: e.message } });
    }
  }

  dispatch(ev) {
    switch (ev.type) {
      case 'freeze': return this.doFreeze(ev);
      case 'unfreeze': return this.doUnfreeze(ev);
      case 'debit': return this.doDebit(ev);
      case 'business_day': return this.doBusinessDay(ev);
      default: throw typeErr(`unknown event type '${ev.type}'`);
    }
  }

  bucket(name) {
    const b = this.buckets.get(name);
    if (!b) throw typeErr(`unknown bucket '${name}'`);
    return b;
  }

  bucketDef(name) {
    return this.policy.buckets[this.policy.bucketIndex[name]];
  }

  checkCommon(ev) {
    if (ev.customer !== this.policy.customer)
      throw scopeErr(`event customer '${ev.customer}' does not match policy customer '${this.policy.customer}'`);
    if (this.policy.noteRegex && !new RegExp(this.policy.noteRegex).test(String(ev.note ?? '')))
      throw noteErr(`note '${ev.note}' rejected by whitelist /${this.policy.noteRegex}/`);
    if (!Number.isSafeInteger(ev.amount) || ev.amount <= 0)
      throw capErr(`amount must be a positive integer, got ${ev.amount}`);
  }

  resolveScope(path) {
    if (!Array.isArray(path) || path.length === 0)
      throw scopeErr('freeze requires a non-empty approval scope path');
    let key = '';
    for (const s of path) {
      key = key ? key + '/' + s : s;
      if (!this.policy.scopeIndex[key]) throw scopeErr(`unknown approval scope path '${key}'`);
    }
    return key;
  }

  rulesAlong(path, op) {
    const rules = [];
    let key = '';
    for (const s of path) {
      key = key ? key + '/' + s : s;
      rules.push(...this.policy.scopeIndex[key].rules.filter((r) => r.op === op));
    }
    return rules;
  }

  guardCtx(ev) {
    return {
      amount: ev.amount,
      note: ev.note,
      bucketState: (i) => this.buckets.get(this.policy.buckets[i].name),
    };
  }

  addScopeFrozen(pathKey, bucket, delta) {
    let key = '';
    for (const s of pathKey.split('/')) {
      key = key ? key + '/' + s : s;
      let m = this.scopeFrozen.get(key);
      if (!m) { m = new Map(); this.scopeFrozen.set(key, m); }
      m.set(bucket, (m.get(bucket) || 0) + delta);
    }
  }

  doFreeze(ev) {
    this.checkCommon(ev);
    const b = this.bucket(ev.bucket);
    const def = this.bucketDef(ev.bucket);
    if (this.freezes.has(ev.id)) throw capErr(`duplicate freeze id '${ev.id}'`);
    const until = String(ev.until ?? '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(until))
      throw expiredErr(`freeze '${ev.id}' until must be a business date YYYY-MM-DD, got '${ev.until}'`);
    const expiry = Date.parse(until + DAY_START);
    const ts = eventTime(ev);
    if (!(ts < expiry))
      throw expiredErr(`freeze '${ev.id}' at ${ev.ts} is not before its expiry ${until}T00:00Z`);
    if (def.validTo && until > def.validTo)
      throw expiredErr(`freeze '${ev.id}' until ${until} exceeds bucket validity end ${def.validTo}`);
    if (def.validFrom && String(ev.ts).slice(0, 10) < def.validFrom)
      throw expiredErr(`freeze '${ev.id}' predates bucket validity start ${def.validFrom}`);
    const pathKey = this.resolveScope(ev.scope);
    runRules(this.rulesAlong(ev.scope, 'freeze'), this.guardCtx(ev));
    if (ev.amount > b.available)
      throw capErr(`freeze ${ev.amount} exceeds available ${b.available} on bucket '${ev.bucket}': rejected without partial deduction`);
    let key = '';
    for (const s of ev.scope) {
      key = key ? key + '/' + s : s;
      const cap = this.policy.scopeIndex[key].caps[ev.bucket];
      if (cap !== undefined) {
        const cur = this.scopeFrozen.get(key)?.get(ev.bucket) || 0;
        if (cur + ev.amount > cap)
          throw capErr(`freeze ${ev.amount} would raise scope '${key}' frozen to ${cur + ev.amount} > cap ${cap}`);
      }
    }
    b.available -= ev.amount;
    b.frozen += ev.amount;
    this.freezes.set(ev.id, {
      id: ev.id, bucket: ev.bucket, amount: ev.amount, used: 0,
      until, scope: pathKey, expired: false,
    });
    this.addScopeFrozen(pathKey, ev.bucket, ev.amount);
  }

  freezeRec(ev) {
    const rec = this.freezes.get(ev.freeze_id);
    if (!rec) throw capErr(`unknown freeze '${ev.freeze_id}'`);
    if (rec.expired) throw expiredErr(`freeze '${rec.id}' already expired`);
    if (!(eventTime(ev) < Date.parse(rec.until + DAY_START)))
      throw expiredErr(`freeze '${rec.id}' expired at ${rec.until}T00:00Z`);
    return rec;
  }

  doUnfreeze(ev) {
    this.checkCommon(ev);
    const rec = this.freezeRec(ev);
    const remaining = rec.amount - rec.used;
    if (ev.amount > remaining)
      throw capErr(`unfreeze ${ev.amount} exceeds unused frozen ${remaining} on '${rec.id}': used quota cannot be released`);
    const b = this.bucket(rec.bucket);
    rec.amount -= ev.amount;
    b.frozen -= ev.amount;
    b.available += ev.amount;
    this.addScopeFrozen(rec.scope, rec.bucket, -ev.amount);
  }

  doDebit(ev) {
    this.checkCommon(ev);
    if (ev.freeze_id) {
      const rec = this.freezeRec(ev);
      const remaining = rec.amount - rec.used;
      if (ev.amount > remaining)
        throw capErr(`debit ${ev.amount} exceeds remaining frozen ${remaining} on '${rec.id}'`);
      runRules(this.rulesAlong(rec.scope.split('/'), 'debit'), this.guardCtx(ev));
      const b = this.bucket(rec.bucket);
      rec.used += ev.amount;
      b.frozen -= ev.amount;
      b.used += ev.amount;
      this.addScopeFrozen(rec.scope, rec.bucket, -ev.amount);
    } else {
      const b = this.bucket(ev.bucket);
      if (ev.amount > b.available)
        throw capErr(`debit ${ev.amount} exceeds available ${b.available} on bucket '${ev.bucket}': rejected without partial deduction`);
      b.available -= ev.amount;
      b.used += ev.amount;
    }
  }

  // Expiry takes effect in batches, once per business day: every freeze whose
  // validity ends at 00:00 on or before this date releases its unused part.
  doBusinessDay(ev) {
    const date = String(ev.date ?? '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date))
      throw typeErr(`business_day requires date YYYY-MM-DD, got '${ev.date}'`);
    const dayStart = Date.parse(date + DAY_START);
    const expired = [];
    for (const rec of this.freezes.values()) {
      if (rec.expired) continue;
      if (Date.parse(rec.until + DAY_START) <= dayStart) {
        const remaining = rec.amount - rec.used;
        const b = this.bucket(rec.bucket);
        b.frozen -= remaining;
        b.available += remaining;
        this.addScopeFrozen(rec.scope, rec.bucket, -remaining);
        rec.expired = true;
        expired.push({ id: rec.id, released: remaining });
      }
    }
    return { date, expired };
  }

  snapshot() {
    return {
      buckets: Object.fromEntries([...this.buckets.entries()].map(([k, v]) => [k, { ...v }])),
      freezes: [...this.freezes.values()].map((r) => ({ ...r })),
    };
  }
}
