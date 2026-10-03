import { rat, add, sub, abs, cmp, toCentsRounded, fromCents, toJSON, fromJSON, ZERO } from './rational.js';
import { loadSegments, curveRoot, segmentAt, integral } from './curve.js';
import { canon, sha256hex, merkleRoot } from './canon.js';
import { dayError, certError, pendingError } from './errors.js';


export class Ledger {
  constructor() {
    this.segments = [];
    this.curveRoot = curveRoot([]);
    this.postings = []; // {id, day, amount:{n,d}, active}
    this.nextId = 1;
    this.cache = new Map(); // day -> exact accrued amount (rational)
    this.stats = { daysComputed: 0 };
  }

  loadCurve({ segments }) {
    this.segments = loadSegments(segments);
    this.curveRoot = curveRoot(this.segments);
    this.cache.clear();
    return { curveRoot: this.curveRoot, segments: this.segments.length };
  }

  coverageEnd() {
    return this.segments.length ? this.segments[this.segments.length - 1].to : 0;
  }

  invalidateFrom(day) {
    for (const k of [...this.cache.keys()]) if (k >= day) this.cache.delete(k);
  }

  post({ day, amountNum, amountDen = 1 }) {
    if (!Number.isInteger(day) || day < 0 || day >= this.coverageEnd() || !segmentAt(this.segments, day)) {
      throw dayError(`post day ${day} out of covered range`);
    }
    const amount = rat(BigInt(amountNum), BigInt(amountDen));
    const id = this.nextId++;
    this.postings.push({ id, day, amount, active: true });
    this.invalidateFrom(day);
    return { id };
  }

  backdate({ day, newAmount }) {
    if (!Number.isInteger(day) || day < 0) throw dayError(`backdate day ${day} out of range`);
    const amount = typeof newAmount === 'object' && newAmount !== null
      ? rat(BigInt(newAmount.num), BigInt(newAmount.den ?? 1))
      : rat(BigInt(newAmount), 1n);
    // Correct the most recent active posting effective at that day.
    const target = [...this.postings].reverse().find((p) => p.active && p.day === day);
    if (!target) throw dayError(`no active posting at day ${day} to backdate`);
    target.amount = amount;
    this.invalidateFrom(day);
    return { id: target.id };
  }

  undoPost({ id }) {
    const p = this.postings.find((x) => x.id === id && x.active);
    if (!p) throw dayError(`no active posting with id ${id}`);
    p.active = false;
    this.invalidateFrom(p.day);
    return { id };
  }

  postingsRoot() {
    const leaves = this.postings
      .filter((p) => p.active)
      .map((p) => sha256hex(canon({ id: p.id, day: p.day, amount: [p.amount.n, p.amount.d] })));
    return merkleRoot(leaves);
  }

  stateRoot() {
    return sha256hex(this.curveRoot + ':' + this.postingsRoot());
  }

  // Exact accrued interest for a single day: sum over active postings with
  // day <= d of amount * integral of the rate over [d, d+1). Cached; a
  // correction at day k only invalidates/recomputes days >= k.
  accrualForDay(d) {
    if (this.cache.has(d)) return this.cache.get(d);
    const seg = segmentAt(this.segments, d);
    if (!seg) throw pendingError(`day ${d} is not covered by the loaded curve`);
    const dayRate = integral(seg, d, d + 1);
    let acc = ZERO;
    for (const p of this.postings) {
      if (p.active && p.day <= d) acc = add(acc, { n: p.amount.n * dayRate.n, d: p.amount.d * dayRate.d });
    }
    acc = rat(acc.n, acc.d);
    this.cache.set(d, acc);
    this.stats.daysComputed++;
    return acc;
  }

  certify({ from, to }) {
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || from >= to) {
      throw dayError(`invalid certify range [${from}, ${to})`);
    }
    // Coverage check first: uncovered ranges yield E_PENDING, never a zero.
    for (let d = from; d < to; d++) {
      if (!segmentAt(this.segments, d)) throw pendingError(`range [${from}, ${to}) is not fully covered by the curve`);
    }
    const before = this.stats.daysComputed;
    const days = [];
    for (let d = from; d < to; d++) {
      days.push({ day: d, exact: toJSON(this.accrualForDay(d)) });
    }
    // Interval sums: one per curve-segment subinterval intersecting [from, to).
    const intervals = [];
    for (const seg of this.segments) {
      const a = Math.max(from, seg.from);
      const b = Math.min(to, seg.to);
      if (a >= b) continue;
      let exactSum = ZERO;
      for (let d = a; d < b; d++) exactSum = add(exactSum, fromJSON(days[d - from].exact));
      const postedCents = toCentsRounded(exactSum);
      const residual = sub(exactSum, fromCents(postedCents));
      intervals.push({ from: a, to: b, exact: toJSON(exactSum), postedCents: postedCents.toString(), residual: toJSON(residual) });
    }
    let residualTo = ZERO;
    for (const iv of intervals) residualTo = add(residualTo, fromJSON(iv.residual));
    const leaves = days.map((e) => sha256hex(canon(e)));
    return {
      from,
      to,
      curveRoot: this.curveRoot,
      stateRoot: this.stateRoot(),
      days,
      intervals,
      residualFrom: toJSON(ZERO),
      residualTo: toJSON(residualTo),
      merkleRoot: merkleRoot(leaves),
      stats: { daysComputed: this.stats.daysComputed - before },
    };
  }

  // Verify a certificate against the currently committed state root. The
  // check is self-contained: day entries -> Merkle root, interval sums and
  // residuals recomputed from the embedded day entries, rounding bound, and
  // finally the committed root. No copy of the original curve is consulted.
  verify(cert) {
    const fail = (m) => { throw certError(m); };
    if (!cert || !Array.isArray(cert.days) || !Array.isArray(cert.intervals)) fail('malformed certificate');
    if (cert.days.length !== cert.to - cert.from) fail('day entries do not cover [from, to)');
    for (let i = 0; i < cert.days.length; i++) {
      if (cert.days[i].day !== cert.from + i) fail(`day sequence broken at index ${i}`);
    }
    const leaves = cert.days.map((e) => sha256hex(canon(e)));
    if (merkleRoot(leaves) !== cert.merkleRoot) fail('merkle root mismatch');
    let residualSum = ZERO;
    for (const iv of cert.intervals) {
      let exactSum = ZERO;
      for (let d = iv.from; d < iv.to; d++) {
        const entry = cert.days[d - cert.from];
        if (!entry) fail(`interval [${iv.from}, ${iv.to}) references missing day ${d}`);
        exactSum = add(exactSum, fromJSON(entry.exact));
      }
      if (cmp(exactSum, fromJSON(iv.exact)) !== 0) fail(`interval [${iv.from}, ${iv.to}) sum mismatch`);
      if (toCentsRounded(exactSum) !== BigInt(iv.postedCents)) fail(`interval [${iv.from}, ${iv.to}) posted cents mismatch`);
      const residual = sub(exactSum, fromCents(BigInt(iv.postedCents)));
      if (cmp(residual, fromJSON(iv.residual)) !== 0) fail(`interval [${iv.from}, ${iv.to}) residual mismatch`);
      residualSum = add(residualSum, residual);
    }
    if (cmp(fromJSON(cert.residualFrom), ZERO) !== 0) fail('residualFrom must be zero');
    if (cmp(residualSum, fromJSON(cert.residualTo)) !== 0) fail('residualTo mismatch');
    // Error bound: total |exact - posted| <= intervals * half a cent.
    const bound = { n: BigInt(cert.intervals.length), d: 200n };
    if (cmp(abs(residualSum), bound) > 0) fail('rounding error bound exceeded');
    if (cert.stateRoot !== this.stateRoot()) fail('committed state root mismatch');
    if (cert.curveRoot !== this.curveRoot) fail('committed curve root mismatch');
    return { ok: true, merkleRoot: cert.merkleRoot, stateRoot: cert.stateRoot };
  }
}
