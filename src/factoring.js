import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';

export class FactoringError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'FactoringError';
    this.code = code;
  }
}

const TOKEN_RE = /[a-z0-9]+|[一-鿿]/gu;

export function tokenize(memo) {
  const tokens = [];
  const text = String(memo ?? '').toLowerCase();
  for (const match of text.matchAll(TOKEN_RE)) tokens.push(match[0]);
  return tokens;
}

export function minWordDistance(memoA, memoB) {
  const a = tokenize(memoA);
  const b = tokenize(memoB);
  const positions = new Map();
  a.forEach((token, i) => {
    const list = positions.get(token);
    if (list) list.push(i);
    else positions.set(token, [i]);
  });
  let best = Infinity;
  b.forEach((token, j) => {
    const list = positions.get(token);
    if (!list) return;
    for (const i of list) {
      const d = Math.abs(i - j);
      if (d < best) best = d;
    }
  });
  return best;
}

export function freezeAmount(faceValue, advanceRate) {
  return Math.round(faceValue * advanceRate * 100) / 100;
}

const EPSILON = 1e-9;

function assertFiniteNumber(value, code, field) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new FactoringError(code, `${field} must be a finite number, got: ${value}`);
  }
}

export class FactoringLedger {
  constructor({ creditLimit, slop = 0 } = {}) {
    assertFiniteNumber(creditLimit, 'INVALID_LIMIT', 'creditLimit');
    if (creditLimit <= 0) {
      throw new FactoringError('INVALID_LIMIT', `creditLimit must be positive, got: ${creditLimit}`);
    }
    if (!Number.isInteger(slop) || slop < 0) {
      throw new FactoringError('INVALID_SLOP', `slop must be a non-negative integer, got: ${slop}`);
    }
    this.creditLimit = creditLimit;
    this.slop = slop;
    this.invoices = new Map();
    this.clusterIndex = [];
    this.nextClusterSeq = 1;
  }

  activeInvoices() {
    return [...this.invoices.values()].filter((inv) => inv.state === 'active');
  }

  frozenTotal() {
    let total = 0;
    for (const inv of this.invoices.values()) {
      if (inv.state === 'active') total += inv.frozenAmount;
    }
    return Math.round(total * 100) / 100;
  }

  available() {
    return Math.round((this.creditLimit - this.frozenTotal()) * 100) / 100;
  }

  addInvoice({ id, creditor, faceValue, advanceRate, memo = '' }) {
    if (id === undefined || id === null || id === '') {
      throw new FactoringError('INVALID_ID', 'invoice id must be a non-empty value');
    }
    id = String(id);
    if (this.invoices.has(id)) {
      throw new FactoringError('DUPLICATE_INVOICE', `invoice already exists: ${id}`);
    }
    if (typeof creditor !== 'string' || creditor.trim() === '') {
      throw new FactoringError('INVALID_CREDITOR', 'creditor must be a non-empty string');
    }
    assertFiniteNumber(faceValue, 'INVALID_FACE_VALUE', 'faceValue');
    if (faceValue <= 0) {
      throw new FactoringError('INVALID_FACE_VALUE', `faceValue must be positive, got: ${faceValue}`);
    }
    assertFiniteNumber(advanceRate, 'INVALID_RATE', 'advanceRate');
    if (advanceRate <= 0 || advanceRate > 1) {
      throw new FactoringError('INVALID_RATE', `advanceRate must be in (0, 1], got: ${advanceRate}`);
    }
    const amount = freezeAmount(faceValue, advanceRate);
    if (this.frozenTotal() + amount - this.creditLimit > EPSILON) {
      throw new FactoringError(
        'LIMIT_EXCEEDED',
        `freezing ${amount} would exceed credit limit ${this.creditLimit} (frozen: ${this.frozenTotal()})`,
      );
    }
    const invoice = {
      id,
      creditor,
      faceValue,
      advanceRate,
      memo: String(memo),
      state: 'active',
      frozenAmount: amount,
    };
    this.invoices.set(id, invoice);
    this.#reindex();
    return { ...invoice };
  }

  revoke(id) {
    id = String(id);
    const invoice = this.invoices.get(id);
    if (!invoice) {
      throw new FactoringError('INVOICE_NOT_FOUND', `no such invoice: ${id}`);
    }
    if (invoice.state !== 'active') {
      throw new FactoringError('ALREADY_REVOKED', `invoice already revoked: ${id}`);
    }
    const priorCluster = this.clusterIndex.find((cluster) => cluster.members.includes(id)) ?? null;
    invoice.state = 'revoked';
    this.#reindex();
    const survivingMembers = priorCluster
      ? priorCluster.members.filter(
          (memberId) => memberId !== id && this.invoices.get(memberId)?.state === 'active',
        )
      : [];
    const clusterStillAlive = priorCluster
      ? this.clusterIndex.some((cluster) => cluster.clusterId === priorCluster.clusterId)
      : false;
    return {
      revokedId: id,
      releasedAmount: invoice.frozenAmount,
      clusterId: priorCluster ? priorCluster.clusterId : null,
      clusterDissolved: Boolean(priorCluster) && !clusterStillAlive,
      survivingMembers,
    };
  }

  clusters() {
    return this.clusterIndex.map((cluster) => ({
      clusterId: cluster.clusterId,
      creditor: cluster.creditor,
      members: [...cluster.members],
    }));
  }

  clusterOf(id) {
    id = String(id);
    const cluster = this.clusterIndex.find((entry) => entry.members.includes(id));
    return cluster ? { clusterId: cluster.clusterId, creditor: cluster.creditor, members: [...cluster.members] } : null;
  }

  matchCandidates(id) {
    id = String(id);
    const origin = this.invoices.get(id);
    if (!origin) throw new FactoringError('INVOICE_NOT_FOUND', `no such invoice: ${id}`);
    const candidates = [];
    for (const other of this.activeInvoices()) {
      if (other.id === id || other.creditor !== origin.creditor) continue;
      const distance = minWordDistance(origin.memo, other.memo);
      if (!Number.isFinite(distance)) continue;
      candidates.push({
        id: other.id,
        distance,
        amountDiff: Math.abs(
          Math.round((other.frozenAmount - origin.frozenAmount) * 100) / 100,
        ),
      });
    }
    candidates.sort((a, b) => a.distance - b.distance || a.amountDiff - b.amountDiff || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return candidates;
  }

  #reindex() {
    const active = this.activeInvoices();
    const parent = new Map(active.map((inv) => [inv.id, inv.id]));
    const find = (x) => {
      while (parent.get(x) !== x) {
        parent.set(x, parent.get(parent.get(x)));
        x = parent.get(x);
      }
      return x;
    };
    const union = (a, b) => {
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) parent.set(rb, ra);
    };
    const byCreditor = new Map();
    for (const inv of active) {
      const list = byCreditor.get(inv.creditor) ?? [];
      list.push(inv);
      byCreditor.set(inv.creditor, list);
    }
    for (const group of byCreditor.values()) {
      for (let i = 0; i < group.length; i += 1) {
        for (let j = i + 1; j < group.length; j += 1) {
          if (minWordDistance(group[i].memo, group[j].memo) <= this.slop) {
            union(group[i].id, group[j].id);
          }
        }
      }
    }
    const groups = new Map();
    for (const inv of active) {
      const root = find(inv.id);
      const list = groups.get(root) ?? [];
      list.push(inv.id);
      groups.set(root, list);
    }
    const previous = this.clusterIndex;
    const nextIndex = [];
    for (const members of groups.values()) {
      if (members.length < 2) continue;
      members.sort();
      const creditor = this.invoices.get(members[0]).creditor;
      const memberSet = new Set(members);
      let best = null;
      let bestOverlap = 0;
      for (const old of previous) {
        if (old.creditor !== creditor) continue;
        let overlap = 0;
        for (const memberId of old.members) if (memberSet.has(memberId)) overlap += 1;
        if (overlap > bestOverlap) {
          bestOverlap = overlap;
          best = old;
        }
      }
      const clusterId = best ? best.clusterId : `C${this.nextClusterSeq++}`;
      nextIndex.push({ clusterId, creditor, members });
    }
    nextIndex.sort((a, b) => (a.clusterId < b.clusterId ? -1 : 1));
    this.clusterIndex = nextIndex;
  }

  toJSON() {
    return {
      version: 1,
      creditLimit: this.creditLimit,
      slop: this.slop,
      nextClusterSeq: this.nextClusterSeq,
      invoices: [...this.invoices.values()].map((inv) => ({ ...inv })),
      clusterIndex: this.clusterIndex.map((cluster) => ({
        clusterId: cluster.clusterId,
        creditor: cluster.creditor,
        members: [...cluster.members],
      })),
    };
  }

  save(file) {
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(this.toJSON(), null, 2)}\n`, 'utf8');
    renameSync(tmp, file);
  }

  static load(file) {
    const data = JSON.parse(readFileSync(file, 'utf8'));
    const ledger = new FactoringLedger({ creditLimit: data.creditLimit, slop: data.slop });
    ledger.nextClusterSeq = data.nextClusterSeq ?? 1;
    for (const inv of data.invoices) ledger.invoices.set(String(inv.id), { ...inv, id: String(inv.id) });
    ledger.clusterIndex = (data.clusterIndex ?? [])
      .filter((cluster) => cluster.members.length > 0)
      .map((cluster) => ({ ...cluster, members: cluster.members.map(String) }));
    ledger.#reindex();
    return ledger;
  }

  static open(file, options) {
    if (existsSync(file)) return FactoringLedger.load(file);
    return new FactoringLedger(options);
  }
}
