'use strict';

const { Frac, roundToCents } = require('./rational');
const { Curve, CurveError } = require('./curve');
const { sha256, merkleRoot } = require('./merkle');

class InterestError extends Error {
  constructor(code, message, details) {
    super(message);
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function emptyState() {
  return { curve: null, curveHash: null, postings: [], certs: [], cache: {}, seq: 0, certSeq: 0 };
}

function parseAmount(value) {
  if (Array.isArray(value)) {
    return new Frac(BigInt(value[0]), BigInt(value[1] === undefined ? 1 : value[1]));
  }
  if (value && typeof value === 'object') {
    return new Frac(BigInt(value.num), BigInt(value.den === undefined ? 1 : value.den));
  }
  if (typeof value === 'string' && value.includes('/')) {
    const [num, den] = value.split('/');
    return new Frac(BigInt(num), BigInt(den));
  }
  return new Frac(BigInt(value));
}

function serializeAmount(f) {
  return f.toString();
}

class Ledger {
  constructor(state) {
    this.state = state || emptyState();
  }

  curve() {
    if (!this.state.curve) return null;
    return new Curve(this.state.curve.segments);
  }

  // Merkle root commits to the curve and the live postings only (never to
  // certs or the cache), so certifying does not move the root.
  root() {
    const leaves = [];
    if (this.state.curve) {
      for (const leaf of this.curve().canonicalLeaves()) leaves.push(leaf);
    }
    const postings = [...this.state.postings].sort((a, b) => a.id - b.id);
    for (const p of postings) {
      leaves.push(`post:${p.id}:${p.day}:${p.amount}:v${p.version}`);
    }
    return merkleRoot(leaves);
  }

  loadCurve({ segments }) {
    try {
      const curve = new Curve(segments);
      this.state.curve = {
        segments: curve.segments.map((s) => ({
          from: s.from,
          to: s.to,
          coefs: s.coefs.map((c) => [c.n.toString(), c.d.toString()]),
        })),
      };
      this.state.curveHash = sha256(curve.canonicalLeaves().join('|'));
      return { ok: true, segments: curve.segments.length, root: this.root() };
    } catch (e) {
      if (e instanceof CurveError) throw new InterestError(e.code, e.message);
      throw e;
    }
  }

  post({ day, amountNum, amountDen }) {
    if (!Number.isInteger(day) || day < 0) {
      throw new InterestError('E_DAY', `invalid posting day ${day}`);
    }
    const curve = this.curve();
    if (!curve || !curve.covers(day)) {
      throw new InterestError('E_DAY', `day ${day} is outside curve coverage`);
    }
    const amount = new Frac(BigInt(amountNum), BigInt(amountDen === undefined ? 1 : amountDen));
    const id = ++this.state.seq;
    this.state.postings.push({ id, day, amount: serializeAmount(amount), version: 1 });
    return { ok: true, id, root: this.root() };
  }

  backdate({ day, newAmount }) {
    if (!Number.isInteger(day)) {
      throw new InterestError('E_DAY', `invalid day ${day}`);
    }
    const targets = this.state.postings.filter((p) => p.day === day);
    if (targets.length === 0) {
      throw new InterestError('E_DAY', `no posting found at day ${day}`);
    }
    const amount = parseAmount(newAmount);
    for (const p of targets) {
      p.amount = serializeAmount(amount);
      p.version += 1; // version bump invalidates only this posting's cache entries
    }
    return { ok: true, corrected: targets.map((p) => p.id), root: this.root() };
  }

  undoPost({ id }) {
    const idx = this.state.postings.findIndex((p) => p.id === id);
    if (idx === -1) {
      throw new InterestError('E_DAY', `unknown posting id ${id}`);
    }
    this.state.postings.splice(idx, 1);
    return { ok: true, removed: id, root: this.root() };
  }

  // Exact accrual over [from, to): for every posting, for every curve segment
  // overlapping [max(posting.day, from), to), integrate the rate polynomial
  // exactly, then round each sub-interval to cents (rounding happens only at
  // booking time). Results are cached per (posting version, segment, range)
  // so a backdate recomputes only the affected integral sub-intervals.
  computeAccrual(from, to) {
    const curve = this.curve();
    const subintervals = [];
    let exactTotal = new Frac(0n);
    let bookedTotal = new Frac(0n);
    let recomputed = 0;
    const involved = new Set();

    const postings = [...this.state.postings].sort((a, b) => a.id - b.id);
    for (const p of postings) {
      const amount = parseAmount(p.amount);
      const start = Math.max(p.day, from);
      if (start >= to) continue;
      for (let si = 0; si < curve.segments.length; si++) {
        const seg = curve.segments[si];
        const lo = Math.max(start, seg.from);
        const hi = Math.min(to, seg.to);
        if (lo >= hi) continue;
        const key = `${this.state.curveHash}:${p.id}:v${p.version}:s${si}:${lo}-${hi}`;
        let integral;
        if (Object.prototype.hasOwnProperty.call(this.state.cache, key)) {
          integral = parseAmount(this.state.cache[key]);
        } else {
          integral = seg.integrate(lo, hi);
          this.state.cache[key] = serializeAmount(integral);
          recomputed += 1;
        }
        const exact = amount.mul(integral);
        const booked = roundToCents(exact);
        const residual = exact.sub(booked);
        exactTotal = exactTotal.add(exact);
        bookedTotal = bookedTotal.add(booked);
        involved.add(si);
        subintervals.push({
          postingId: p.id,
          segment: si,
          from: lo,
          to: hi,
          exact: serializeAmount(exact),
          booked: serializeAmount(booked),
          residual: serializeAmount(residual),
        });
      }
    }

    const residual = exactTotal.sub(bookedTotal);
    const segmentsInvolved = involved.size;
    // Error bound: each booked sub-interval rounds at most half a cent, and
    // each posting crosses at most `segmentsInvolved` segments.
    const errorBound = new Frac(BigInt(segmentsInvolved), 200n);
    return {
      subintervals,
      exactTotal,
      bookedTotal,
      residual,
      segmentsInvolved,
      errorBound,
      stats: { subintervals: subintervals.length, recomputed, reused: subintervals.length - recomputed },
    };
  }

  certify({ from, to }) {
    if (!Number.isInteger(from) || !Number.isInteger(to) || from >= to) {
      throw new InterestError('E_DAY', `invalid certify range [${from}, ${to})`);
    }
    const curve = this.curve();
    const gaps = curve ? curve.uncovered(from, to) : [[from, to]];
    if (gaps.length > 0) {
      throw new InterestError('E_PENDING', `range [${from}, ${to}) is not fully covered by the curve`, {
        uncovered: gaps,
      });
    }
    const acc = this.computeAccrual(from, to);
    if (acc.residual.abs().cmp(acc.errorBound) > 0) {
      throw new InterestError('E_CERT', 'rounding residual exceeds error bound');
    }
    const first = acc.subintervals[0];
    const last = acc.subintervals[acc.subintervals.length - 1];
    const cert = {
      id: `cert-${++this.state.certSeq}`,
      from,
      to,
      root: this.root(),
      exactTotal: serializeAmount(acc.exactTotal),
      bookedTotal: serializeAmount(acc.bookedTotal),
      residual: serializeAmount(acc.residual),
      endpointResiduals: {
        from: first ? first.residual : '0',
        to: last ? last.residual : '0',
      },
      segmentsInvolved: acc.segmentsInvolved,
      errorBound: serializeAmount(acc.errorBound),
      subintervals: acc.subintervals,
      stats: acc.stats,
    };
    this.state.certs.push(cert);
    return cert;
  }

  // Verification uses the committed Merkle root, not a stored copy of the
  // curve: if the curve or any posting changed since certification, the root
  // no longer matches and the certificate is stale.
  verify({ certId, id }) {
    const want = certId !== undefined ? certId : id;
    const cert = this.state.certs.find((c) => c.id === want);
    if (!cert) {
      throw new InterestError('E_CERT', `unknown certificate ${want}`);
    }
    const currentRoot = this.root();
    if (currentRoot !== cert.root) {
      throw new InterestError('E_CERT', 'stale certificate: committed root does not match current state', {
        certRoot: cert.root,
        currentRoot,
      });
    }
    const acc = this.computeAccrual(cert.from, cert.to);
    const mismatches = [];
    if (serializeAmount(acc.exactTotal) !== cert.exactTotal) mismatches.push('exactTotal');
    if (serializeAmount(acc.bookedTotal) !== cert.bookedTotal) mismatches.push('bookedTotal');
    if (serializeAmount(acc.residual) !== cert.residual) mismatches.push('residual');
    if (mismatches.length > 0) {
      throw new InterestError('E_CERT', `recomputed totals diverge: ${mismatches.join(', ')}`);
    }
    if (acc.residual.abs().cmp(acc.errorBound) > 0) {
      throw new InterestError('E_CERT', 'rounding residual exceeds error bound');
    }
    return {
      ok: true,
      certId: cert.id,
      root: cert.root,
      exactTotal: cert.exactTotal,
      bookedTotal: cert.bookedTotal,
      residual: cert.residual,
      errorBound: serializeAmount(acc.errorBound),
    };
  }
}

module.exports = { Ledger, InterestError, emptyState };
