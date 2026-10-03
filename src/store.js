import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { PositionalIndex } from './index.js';

export class QuotaError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'QuotaError';
    this.code = code;
  }
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

export class Store {
  constructor(dir) {
    this.dir = dir;
    this.segDir = path.join(dir, 'index');
    fs.mkdirSync(this.segDir, { recursive: true });
    this._load();
  }

  _load() {
    const dataFile = path.join(this.dir, 'data.json');
    if (fs.existsSync(dataFile)) {
      const d = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
      this.seq = d.seq;
      this.cert = d.cert;
      this.requests = new Map(Object.entries(d.requests));
    } else {
      this.seq = 0;
      this.cert = 'genesis';
      this.requests = new Map();
    }
    this.index = new PositionalIndex();
    const segs = fs
      .readdirSync(this.segDir)
      .filter((f) => /^seg-\d+\.json$/.test(f))
      .sort();
    for (const f of segs) {
      this.index.applySegment(JSON.parse(fs.readFileSync(path.join(this.segDir, f), 'utf8')));
    }
    this.segCount = segs.length;
  }

  _save() {
    const data = {
      seq: this.seq,
      cert: this.cert,
      requests: Object.fromEntries(this.requests),
    };
    const tmp = path.join(this.dir, `data.json.${process.pid}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, path.join(this.dir, 'data.json'));
  }

  _writeSegment(docs) {
    this.segCount += 1;
    const name = `seg-${String(this.segCount).padStart(6, '0')}.json`;
    const seg = { docs: {} };
    for (const d of docs) seg.docs[d.docId] = { state: d.state, terms: d.terms };
    fs.writeFileSync(path.join(this.segDir, name), JSON.stringify(seg));
  }

  _certify(op, payload) {
    this.seq += 1;
    this.cert = sha256(`${this.cert}|${op}|${this.seq}|${JSON.stringify(payload)}`);
    return { version: this.seq, hash: this.cert };
  }

  _get(id) {
    const req = this.requests.get(id);
    if (!req) throw new QuotaError('NOT_FOUND', `request not found: ${id}`);
    return req;
  }

  _checkVersion(req, expectedVersion) {
    if (expectedVersion === undefined || expectedVersion === null) {
      throw new QuotaError('VERSION_REQUIRED', `expectedVersion is required for ${req.id}`);
    }
    if (req.version !== expectedVersion) {
      throw new QuotaError(
        'STALE_VERSION',
        `stale version for ${req.id}: expected ${expectedVersion}, current ${req.version}`
      );
    }
  }

  _children(id) {
    const out = [];
    for (const r of this.requests.values()) if (r.parentId === id) out.push(r);
    return out;
  }

  // Sum of frozen amounts of all active requests in the subtree rooted at id.
  frozenSum(id) {
    const req = this.requests.get(id);
    if (!req) return 0;
    let sum = req.state === 'active' ? req.amount : 0;
    for (const child of this._children(id)) sum += this.frozenSum(child.id);
    return sum;
  }

  remaining(id) {
    const req = this._get(id);
    return req.quota - this.frozenSum(id);
  }

  // Ancestor chain from root down to (and including) id.
  _chainTo(id) {
    const chain = [];
    let cur = this.requests.get(id);
    while (cur) {
      chain.unshift(cur);
      cur = cur.parentId ? this.requests.get(cur.parentId) : null;
    }
    return chain;
  }

  _levelsFor(ancestors, delta) {
    return ancestors.map((a) => ({
      id: a.id,
      before: a.quota - this.frozenSum(a.id) + delta,
      after: a.quota - this.frozenSum(a.id),
    }));
  }

  // Freeze a new request. Parent must exist and be active; the frozen amount
  // must fit within the remaining freezable quota of every ancestor level,
  // and within the request's own quota.
  freeze({ id, parentId = null, amount, quota, policyText = '' }) {
    if (!id || typeof id !== 'string') {
      throw new QuotaError('INVALID_ID', 'id must be a non-empty string');
    }
    if (this.requests.has(id)) {
      throw new QuotaError('DUPLICATE_ID', `request already exists: ${id}`);
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new QuotaError('INVALID_AMOUNT', `amount must be a positive number, got ${amount}`);
    }
    if (!Number.isFinite(quota) || quota < amount) {
      throw new QuotaError('INVALID_QUOTA', `quota must be >= amount (${amount}), got ${quota}`);
    }
    let ancestors = [];
    if (parentId !== null && parentId !== undefined) {
      const parent = this.requests.get(parentId);
      if (!parent) throw new QuotaError('PARENT_NOT_FOUND', `parent not found: ${parentId}`);
      if (parent.state !== 'active') {
        throw new QuotaError('PARENT_NOT_ACTIVE', `parent not active: ${parentId} (${parent.state})`);
      }
      ancestors = this._chainTo(parentId);
      for (const a of ancestors) {
        if (this.remaining(a.id) < amount) {
          throw new QuotaError(
            'QUOTA_EXCEEDED',
            `amount ${amount} exceeds remaining quota ${this.remaining(a.id)} at level ${a.id}`
          );
        }
      }
    }
    const req = { id, parentId: parentId ?? null, amount, quota, policyText, state: 'active', version: 1 };
    this.requests.set(id, req);
    this.index.add(id, policyText);
    this._writeSegment([PositionalIndex.encodeDoc(id, 'active', policyText)]);
    const certificate = this._certify('freeze', { id, parentId: req.parentId, amount, quota });
    this._save();
    return {
      request: { ...req },
      levels: this._levelsFor(ancestors, amount),
      occupancyChain: [...ancestors.map((a) => ({ id: a.id, amount: a.amount })), { id, amount }],
      certificate,
    };
  }

  // Logical delete: excluded from queries and quota consumption, restorable.
  expire(id, expectedVersion) {
    const req = this._get(id);
    this._checkVersion(req, expectedVersion);
    if (req.state !== 'active') {
      throw new QuotaError('ALREADY_EXPIRED', `request already expired: ${id}`);
    }
    const ancestors = this._chainTo(id).slice(0, -1);
    const delta = this.frozenSum(id);
    req.state = 'expired';
    req.version += 1;
    this.index.remove(id);
    this._writeSegment([PositionalIndex.encodeDoc(id, 'expired', '')]);
    const certificate = this._certify('expire', { id, version: req.version });
    this._save();
    return {
      request: { ...req },
      levels: this._levelsFor(ancestors, -delta),
      occupancyChain: this._chainTo(id).map((a) => ({ id: a.id, amount: a.amount })),
      certificate,
    };
  }

  // Restore a logically deleted request, re-validating quota constraints.
  restore(id, expectedVersion) {
    const req = this._get(id);
    this._checkVersion(req, expectedVersion);
    if (req.state !== 'expired') {
      throw new QuotaError('NOT_EXPIRED', `request is not expired: ${id}`);
    }
    // Delta that would re-enter the books: this request plus its active subtree.
    const delta = req.amount + this._children(id).reduce((s, c) => s + this.frozenSum(c.id), 0);
    if (req.quota < delta) {
      throw new QuotaError('QUOTA_EXCEEDED', `restored subtree ${delta} exceeds own quota ${req.quota}`);
    }
    const ancestors = this._chainTo(id).slice(0, -1);
    for (const a of ancestors) {
      if (this.remaining(a.id) < delta) {
        throw new QuotaError(
          'QUOTA_EXCEEDED',
          `restored subtree ${delta} exceeds remaining quota ${this.remaining(a.id)} at level ${a.id}`
        );
      }
    }
    req.state = 'active';
    req.version += 1;
    this.index.add(id, req.policyText);
    this._writeSegment([PositionalIndex.encodeDoc(id, 'active', req.policyText)]);
    const certificate = this._certify('restore', { id, version: req.version });
    this._save();
    return {
      request: { ...req },
      levels: this._levelsFor(ancestors, delta),
      occupancyChain: this._chainTo(id).map((a) => ({ id: a.id, amount: a.amount })),
      certificate,
    };
  }

  // Update amount and/or policyText with optimistic concurrency control.
  update(id, expectedVersion, patch = {}) {
    const req = this._get(id);
    this._checkVersion(req, expectedVersion);
    if (req.state !== 'active') {
      throw new QuotaError('NOT_ACTIVE', `cannot update ${req.state} request: ${id}`);
    }
    const { amount, policyText } = patch;
    let amountDelta = 0;
    if (amount !== undefined) {
      if (!Number.isFinite(amount) || amount <= 0) {
        throw new QuotaError('INVALID_AMOUNT', `amount must be a positive number, got ${amount}`);
      }
      const delta = amount - req.amount;
      amountDelta = delta;
      if (req.quota < this.frozenSum(id) + delta) {
        throw new QuotaError('QUOTA_EXCEEDED', `amount ${amount} exceeds own quota ${req.quota}`);
      }
      for (const a of this._chainTo(id).slice(0, -1)) {
        if (this.remaining(a.id) < delta) {
          throw new QuotaError(
            'QUOTA_EXCEEDED',
            `amount delta ${delta} exceeds remaining quota ${this.remaining(a.id)} at level ${a.id}`
          );
        }
      }
      req.amount = amount;
    }
    if (policyText !== undefined) {
      req.policyText = String(policyText);
      this.index.add(id, req.policyText);
    }
    req.version += 1;
    this._writeSegment([PositionalIndex.encodeDoc(id, 'active', req.policyText)]);
    const certificate = this._certify('update', { id, version: req.version });
    this._save();
    return {
      request: { ...req },
      levels: this._levelsFor(this._chainTo(id).slice(0, -1), amountDelta),
      occupancyChain: this._chainTo(id).map((a) => ({ id: a.id, amount: a.amount })),
      certificate,
    };
  }

  // Physical delete of all expired requests; merges compressed index segments
  // into a single segment. Purged requests are unrecoverable.
  purge() {
    const expired = [...this.requests.values()].filter((r) => r.state === 'expired');
    for (const r of expired) {
      this.requests.delete(r.id);
      this.index.remove(r.id);
    }
    const activeDocs = [...this.requests.values()]
      .filter((r) => r.state === 'active')
      .map((r) => ({ id: r.id, text: r.policyText }));
    for (const f of fs.readdirSync(this.segDir)) {
      if (/^seg-\d+\.json$/.test(f)) fs.unlinkSync(path.join(this.segDir, f));
    }
    this.segCount = 0;
    this._writeSegment([...activeDocs].map((d) => PositionalIndex.encodeDoc(d.id, 'active', d.text)));
    const certificate = this._certify('purge', { purged: expired.map((r) => r.id).sort() });
    this._save();
    return { purged: expired.map((r) => r.id).sort(), segments: this.segCount, certificate };
  }

  query(phrase) {
    return this.index.search(phrase);
  }

  get(id) {
    return { ...this._get(id) };
  }

  list() {
    return [...this.requests.values()].map((r) => ({ ...r }));
  }

  balance(id) {
    const req = this._get(id);
    const frozen = this.frozenSum(id);
    return { id: req.id, quota: req.quota, frozen, remaining: req.quota - frozen };
  }

  certificate() {
    return { version: this.seq, hash: this.cert };
  }
}
