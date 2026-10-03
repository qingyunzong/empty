'use strict';

const fs = require('node:fs');
const path = require('node:path');

class FactoringError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'FactoringError';
    this.code = code;
  }
}

function tokenize(memo) {
  if (typeof memo !== 'string') return [];
  return memo.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

// All ordered word pairs (a, b) with a before b and at most `slop` words
// between them. Returns Map: pairKey -> minimal gap (words in between).
// Tokens never contain '|' (tokenize splits on non-alphanumerics).
function pairKey(a, b) {
  return a + '|' + b;
}

function wordPairWindows(tokens, slop) {
  const pairs = new Map();
  for (let i = 0; i < tokens.length; i++) {
    const maxJ = Math.min(tokens.length - 1, i + slop + 1);
    for (let j = i + 1; j <= maxJ; j++) {
      const key = pairKey(tokens[i], tokens[j]);
      const gap = j - i - 1;
      const prev = pairs.get(key);
      if (prev === undefined || gap < prev) pairs.set(key, gap);
    }
  }
  return pairs;
}

class FactoringStore {
  constructor({ creditLine, slop = 1, file = null } = {}) {
    if (!Number.isFinite(creditLine) || creditLine < 0) {
      throw new FactoringError('INVALID_CREDIT_LINE', `creditLine must be a finite number >= 0, got ${creditLine}`);
    }
    if (!Number.isInteger(slop) || slop < 0) {
      throw new FactoringError('INVALID_SLOP', `slop must be an integer >= 0, got ${slop}`);
    }
    this.creditLine = creditLine;
    this.slop = slop;
    this.file = file;
    this.invoices = new Map();
    this.clusterSlots = [];
    this.nextClusterSeq = 1;
  }

  static load(file) {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const store = new FactoringStore({ creditLine: raw.creditLine, slop: raw.slop, file });
    store.nextClusterSeq = raw.nextClusterSeq;
    for (const inv of raw.invoices) store.invoices.set(inv.id, { ...inv });
    store.clusterSlots = raw.clusterSlots.map((s) => ({ ...s, members: [...s.members] }));
    return store;
  }

  save() {
    if (!this.file) return;
    const data = {
      version: 1,
      creditLine: this.creditLine,
      slop: this.slop,
      nextClusterSeq: this.nextClusterSeq,
      invoices: [...this.invoices.values()],
      clusterSlots: this.clusterSlots,
    };
    const tmp = this.file + '.tmp';
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, this.file);
  }

  activeInvoices() {
    return [...this.invoices.values()].filter((inv) => inv.state === 'active');
  }

  totals() {
    let frozen = 0;
    for (const inv of this.invoices.values()) {
      if (inv.state === 'active') frozen += inv.faceValue * inv.advanceRate;
    }
    return {
      creditLine: this.creditLine,
      frozen,
      available: this.creditLine - frozen,
    };
  }

  addInvoice({ id, creditor, faceValue, advanceRate, memo = '' }) {
    if (typeof id !== 'string' || id.length === 0) {
      throw new FactoringError('INVALID_INVOICE_ID', 'invoice id must be a non-empty string');
    }
    if (this.invoices.has(id)) {
      throw new FactoringError('DUPLICATE_INVOICE_ID', `invoice id already exists: ${id}`);
    }
    if (typeof creditor !== 'string' || creditor.length === 0) {
      throw new FactoringError('INVALID_CREDITOR', 'creditor must be a non-empty string');
    }
    if (!Number.isFinite(faceValue) || faceValue <= 0) {
      throw new FactoringError('INVALID_FACE_VALUE', `faceValue must be a finite number > 0, got ${faceValue}`);
    }
    if (!Number.isFinite(advanceRate) || advanceRate <= 0 || advanceRate > 1) {
      throw new FactoringError('INVALID_ADVANCE_RATE', `advanceRate must be in (0, 1], got ${advanceRate}`);
    }
    const amount = faceValue * advanceRate;
    const { available } = this.totals();
    if (amount > available) {
      throw new FactoringError(
        'CREDIT_LINE_EXCEEDED',
        `freeze of ${amount} exceeds available credit ${available}`
      );
    }
    const invoice = { id, creditor, faceValue, advanceRate, memo, state: 'active' };
    this.invoices.set(id, invoice);
    this.recomputeClusters();
    this.save();
    return { ...invoice };
  }

  revokeInvoice(id) {
    const inv = this.invoices.get(id);
    if (!inv) {
      throw new FactoringError('INVOICE_NOT_FOUND', `no such invoice: ${id}`);
    }
    if (inv.state === 'revoked') {
      throw new FactoringError('INVOICE_ALREADY_REVOKED', `invoice already revoked: ${id}`);
    }
    const priorCluster = this.clusterSlots.find((s) => s.members.includes(id)) || null;
    const rankedById = new Map(this.rankCandidates(id).map((c) => [c.id, c]));
    const releasedAmount = inv.faceValue * inv.advanceRate;

    inv.state = 'revoked';
    this.recomputeClusters();

    const survivingIds = priorCluster
      ? priorCluster.members.filter((m) => m !== id && this.invoices.get(m).state === 'active')
      : [];
    // Every live member of the former cluster is listed. Directly related
    // members sort first by (wordDistance, amountDiff, id); transitive-only
    // members follow, ordered by (amountDiff, id).
    const survivingMembers = survivingIds
      .map((mid) => {
        const direct = rankedById.get(mid);
        if (direct) return direct;
        const other = this.invoices.get(mid);
        return {
          id: mid,
          creditor: other.creditor,
          faceValue: other.faceValue,
          wordDistance: null,
          amountDiff: Math.abs(other.faceValue - inv.faceValue),
          sharedPairCount: 0,
        };
      })
      .sort((a, b) => {
        const distA = a.wordDistance === null ? Infinity : a.wordDistance;
        const distB = b.wordDistance === null ? Infinity : b.wordDistance;
        return (
          distA - distB ||
          a.amountDiff - b.amountDiff ||
          (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
        );
      });
    const clusterRemoved = !!priorCluster && !this.clusterSlots.some((s) => s.id === priorCluster.id);

    const certificate = {
      invoiceId: id,
      creditor: inv.creditor,
      releasedAmount,
      clusterId: priorCluster ? priorCluster.id : null,
      survivingMembers,
      clusterRemoved,
    };
    this.save();
    return certificate;
  }

  getInvoice(id) {
    const inv = this.invoices.get(id);
    return inv ? { ...inv } : null;
  }

  listInvoices() {
    return [...this.invoices.values()].map((inv) => ({ ...inv }));
  }

  clusters() {
    return this.clusterSlots.map((s) => ({ id: s.id, creditor: s.creditor, members: [...s.members] }));
  }

  // Active invoices related to `id` (same creditor, shared word pair within
  // slop), sorted by word distance asc, then |faceValue diff| asc, then id asc.
  rankCandidates(id) {
    const inv = this.invoices.get(id);
    if (!inv || inv.state !== 'active') return [];
    const windows = wordPairWindows(tokenize(inv.memo), this.slop);
    const out = [];
    for (const other of this.invoices.values()) {
      if (other.id === id || other.state !== 'active' || other.creditor !== inv.creditor) continue;
      const otherWindows = wordPairWindows(tokenize(other.memo), this.slop);
      let best = null;
      let sharedPairCount = 0;
      for (const [key, gap] of windows) {
        if (otherWindows.has(key)) {
          sharedPairCount += 1;
          if (best === null || gap < best) best = gap;
        }
      }
      if (best !== null) {
        out.push({
          id: other.id,
          creditor: other.creditor,
          faceValue: other.faceValue,
          wordDistance: best,
          amountDiff: Math.abs(other.faceValue - inv.faceValue),
          sharedPairCount,
        });
      }
    }
    out.sort((a, b) =>
      a.wordDistance - b.wordDistance ||
      a.amountDiff - b.amountDiff ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    );
    return out;
  }

  recomputeClusters() {
    const active = this.activeInvoices();
    const activeIds = new Set(active.map((inv) => inv.id));
    const byCreditor = new Map();
    for (const inv of active) {
      if (!byCreditor.has(inv.creditor)) byCreditor.set(inv.creditor, []);
      byCreditor.get(inv.creditor).push(inv);
    }
    const windowsById = new Map();
    for (const inv of active) {
      windowsById.set(inv.id, wordPairWindows(tokenize(inv.memo), this.slop));
    }
    // Connected components (size >= 2) per creditor.
    const components = [];
    for (const [creditor, list] of byCreditor) {
      const parent = new Map(list.map((inv) => [inv.id, inv.id]));
      const find = (x) => {
        while (parent.get(x) !== x) {
          parent.set(x, parent.get(parent.get(x)));
          x = parent.get(x);
        }
        return x;
      };
      const union = (a, b) => parent.set(find(a), find(b));
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          const a = windowsById.get(list[i].id);
          const b = windowsById.get(list[j].id);
          let related = false;
          for (const key of a.keys()) {
            if (b.has(key)) { related = true; break; }
          }
          if (related) union(list[i].id, list[j].id);
        }
      }
      const buckets = new Map();
      for (const inv of list) {
        const root = find(inv.id);
        if (!buckets.has(root)) buckets.set(root, []);
        buckets.get(root).push(inv.id);
      }
      for (const members of buckets.values()) {
        if (members.length >= 2) {
          components.push({ creditor, members: [...members].sort() });
        }
      }
    }
    // Reconcile slots:
    // - a slot survives while any member is still active (even a singleton);
    // - a slot whose members all vanished is physically dropped (compaction);
    // - a slot intersecting a live component absorbs the whole component
    //   (growth on add, merge when a new invoice bridges clusters);
    // - brand-new components get fresh slot ids appended at the end.
    const claimed = new Set();
    const slots = [];
    for (const slot of this.clusterSlots) {
      const liveMembers = slot.members.filter((id) => activeIds.has(id));
      if (liveMembers.length === 0) continue;
      const compIdx = components.findIndex(
        (c) => c.creditor === slot.creditor && c.members.some((id) => liveMembers.includes(id))
      );
      if (compIdx >= 0) {
        if (claimed.has(compIdx)) continue; // absorbed into an earlier slot
        claimed.add(compIdx);
        slots.push({ id: slot.id, creditor: slot.creditor, members: components[compIdx].members });
      } else {
        slots.push({ id: slot.id, creditor: slot.creditor, members: liveMembers.sort() });
      }
    }
    for (let i = 0; i < components.length; i++) {
      if (claimed.has(i)) continue;
      slots.push({ id: `C${this.nextClusterSeq++}`, creditor: components[i].creditor, members: components[i].members });
    }
    this.clusterSlots = slots;
  }
}

module.exports = { FactoringStore, FactoringError, tokenize, wordPairWindows };
