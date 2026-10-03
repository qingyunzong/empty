'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');

class QuotaError extends Error {
  constructor(message) {
    super(message);
    this.name = 'QuotaError';
    this.code = 'QUOTA_EXCEEDED';
  }
}

class NotFoundError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NotFoundError';
    this.code = 'NOT_FOUND';
  }
}

class StaleVersionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'StaleVersionError';
    this.code = 'STALE_VERSION';
  }
}

class StateError extends Error {
  constructor(message) {
    super(message);
    this.name = 'StateError';
    this.code = 'INVALID_STATE';
  }
}

const TOKEN_RE = /[A-Za-z0-9]+|[一-鿿]/g;

function tokenize(text) {
  if (typeof text !== 'string' || text.length === 0) return [];
  const matches = text.toLowerCase().match(TOKEN_RE);
  return matches === null ? [] : matches;
}

function atomicWriteFile(file, data) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

class Store {
  constructor(dir) {
    this.dir = dir;
    this.segmentsDir = path.join(dir, 'segments');
    this.stateFile = path.join(dir, 'state.json');
    this.requests = new Map();
    this.docTokens = new Map();
    this.inverted = new Map();
    this.segCounter = 0;
    this._load();
  }

  _load() {
    fs.mkdirSync(this.segmentsDir, { recursive: true });
    if (fs.existsSync(this.stateFile)) {
      const state = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
      this.segCounter = state.segCounter;
      for (const req of state.requests) {
        this.requests.set(req.id, req);
      }
    }
    const segFiles = fs.readdirSync(this.segmentsDir)
      .filter((name) => name.endsWith('.json.gz'))
      .sort();
    for (const name of segFiles) {
      const raw = zlib.gunzipSync(fs.readFileSync(path.join(this.segmentsDir, name)));
      const segment = JSON.parse(raw.toString('utf8'));
      for (const [docId, tokens] of Object.entries(segment.entries)) {
        if (tokens === null) {
          this.docTokens.delete(docId);
        } else {
          this.docTokens.set(docId, tokens);
        }
      }
    }
    this._rebuildInverted();
  }

  _rebuildInverted() {
    this.inverted = new Map();
    for (const [docId, tokens] of this.docTokens) {
      for (let pos = 0; pos < tokens.length; pos += 1) {
        const term = tokens[pos];
        let postings = this.inverted.get(term);
        if (postings === undefined) {
          postings = new Map();
          this.inverted.set(term, postings);
        }
        let positions = postings.get(docId);
        if (positions === undefined) {
          positions = [];
          postings.set(docId, positions);
        }
        positions.push(pos);
      }
    }
  }

  _saveState() {
    const state = {
      segCounter: this.segCounter,
      requests: [...this.requests.values()],
    };
    atomicWriteFile(this.stateFile, JSON.stringify(state, null, 2));
  }

  _appendSegment(entries) {
    this.segCounter += 1;
    const name = `seg-${String(this.segCounter).padStart(6, '0')}.json.gz`;
    const payload = zlib.gzipSync(Buffer.from(JSON.stringify({ entries }), 'utf8'));
    atomicWriteFile(path.join(this.segmentsDir, name), payload);
    this._saveState();
  }

  _indexDoc(docId, tokens) {
    if (tokens === null) {
      this.docTokens.delete(docId);
    } else {
      this.docTokens.set(docId, tokens);
    }
    this._rebuildInverted();
    this._appendSegment({ [docId]: tokens });
  }

  _childrenOf(id) {
    const children = [];
    for (const req of this.requests.values()) {
      if (req.parentId === id) children.push(req);
    }
    return children;
  }

  used(id) {
    const req = this.requests.get(id);
    if (req === undefined || req.state !== 'active') return 0;
    let total = req.amount;
    for (const child of this._childrenOf(id)) {
      total += this.used(child.id);
    }
    return total;
  }

  balance(id) {
    const req = this.requests.get(id);
    if (req === undefined) throw new NotFoundError(`request not found: ${id}`);
    return req.quota - this.used(id);
  }

  chainOf(id) {
    const chain = [];
    let cursor = this.requests.get(id);
    if (cursor === undefined) throw new NotFoundError(`request not found: ${id}`);
    while (cursor !== undefined && cursor !== null) {
      chain.unshift(cursor);
      cursor = cursor.parentId === null ? null : this.requests.get(cursor.parentId);
    }
    return chain;
  }

  _certificate(req) {
    const payload = JSON.stringify({
      id: req.id,
      parentId: req.parentId,
      amount: req.amount,
      quota: req.quota,
      state: req.state,
      version: req.version,
    });
    return {
      id: req.id,
      version: req.version,
      digest: crypto.createHash('sha256').update(payload).digest('hex'),
    };
  }

  _result(req, levels) {
    return {
      request: { ...req },
      levels,
      occupancyChain: this.chainOf(req.id).map((node) => ({
        id: node.id,
        used: this.used(node.id),
        quota: node.quota,
      })),
      certificate: this._certificate(req),
    };
  }

  _assertChainCapacity(chain, extraAmount) {
    for (const ancestor of chain) {
      if (this.used(ancestor.id) + extraAmount > ancestor.quota) {
        throw new QuotaError(
          `freeze of ${extraAmount} exceeds remaining quota at level ${ancestor.id} ` +
          `(used=${this.used(ancestor.id)}, quota=${ancestor.quota})`,
        );
      }
    }
  }

  freeze({ id, parentId = null, amount, quota, policyText = '' }) {
    if (typeof id !== 'string' || id.length === 0) {
      throw new StateError('id must be a non-empty string');
    }
    if (this.requests.has(id)) {
      throw new StateError(`request already exists: ${id}`);
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new StateError('amount must be a positive number');
    }
    if (!Number.isFinite(quota) || quota < amount) {
      throw new QuotaError(`quota ${quota} cannot be less than amount ${amount}`);
    }

    let ancestors = [];
    if (parentId !== null) {
      const parent = this.requests.get(parentId);
      if (parent === undefined) {
        throw new NotFoundError(`parent request not found: ${parentId}`);
      }
      if (parent.state !== 'active') {
        throw new StateError(`parent request is not active: ${parentId} (state=${parent.state})`);
      }
      ancestors = this.chainOf(parentId);
    }

    this._assertChainCapacity(ancestors, amount);

    const levels = ancestors.map((ancestor) => ({
      id: ancestor.id,
      preBalance: ancestor.quota - this.used(ancestor.id),
    }));
    levels.push({ id, preBalance: quota });

    const req = {
      id,
      parentId,
      amount,
      quota,
      policyText,
      state: 'active',
      version: 1,
    };
    this.requests.set(id, req);
    this._indexDoc(id, tokenize(policyText));

    for (const level of levels) {
      level.postBalance = level.id === id
        ? quota - this.used(id)
        : this.requests.get(level.id).quota - this.used(level.id);
    }

    return this._result(req, levels);
  }

  _getExisting(id) {
    const req = this.requests.get(id);
    if (req === undefined) throw new NotFoundError(`request not found: ${id}`);
    return req;
  }

  expire(id) {
    const req = this._getExisting(id);
    if (req.state !== 'active') {
      throw new StateError(`cannot expire request in state: ${req.state}`);
    }
    req.state = 'expired';
    req.version += 1;
    this._indexDoc(id, null);
    this._saveState();
    return this._result(req, []);
  }

  restore(id) {
    const req = this._getExisting(id);
    if (req.state !== 'expired') {
      throw new StateError(`cannot restore request in state: ${req.state}`);
    }
    if (req.parentId !== null) {
      const parent = this.requests.get(req.parentId);
      if (parent === undefined || parent.state !== 'active') {
        throw new StateError(`cannot restore: parent is not active: ${req.parentId}`);
      }
      this._assertChainCapacity(this.chainOf(req.parentId), this._subtreeAmount(id));
    }
    req.state = 'active';
    req.version += 1;
    this._indexDoc(id, tokenize(req.policyText));
    this._saveState();
    return this._result(req, []);
  }

  _subtreeAmount(id) {
    const req = this.requests.get(id);
    let total = req.amount;
    for (const child of this._childrenOf(id)) {
      if (child.state === 'active') total += this._subtreeAmount(child.id);
    }
    return total;
  }

  purge() {
    const removed = [];
    let changed = true;
    while (changed) {
      changed = false;
      for (const req of [...this.requests.values()]) {
        const parentGone = req.parentId !== null && !this.requests.has(req.parentId);
        if (req.state === 'expired' || parentGone) {
          this.requests.delete(req.id);
          this.docTokens.delete(req.id);
          removed.push(req.id);
          changed = true;
        }
      }
    }

    const entries = {};
    for (const [docId, tokens] of this.docTokens) {
      if (this.requests.has(docId)) entries[docId] = tokens;
    }
    for (const name of fs.readdirSync(this.segmentsDir)) {
      if (name.endsWith('.json.gz')) fs.unlinkSync(path.join(this.segmentsDir, name));
    }
    this._rebuildInverted();
    this._appendSegment(entries);
    this._saveState();
    return { purged: removed };
  }

  update(id, expectedVersion, patch) {
    const req = this._getExisting(id);
    if (req.version !== expectedVersion) {
      throw new StaleVersionError(
        `stale version for ${id}: expected ${req.version}, got ${expectedVersion}`,
      );
    }

    const next = { ...req };
    if (patch.policyText !== undefined) next.policyText = patch.policyText;
    if (patch.quota !== undefined) next.quota = patch.quota;
    if (patch.amount !== undefined) next.amount = patch.amount;

    if (!Number.isFinite(next.amount) || next.amount <= 0) {
      throw new StateError('amount must be a positive number');
    }
    if (next.quota < this.used(id) - req.amount + next.amount) {
      throw new QuotaError(`quota ${next.quota} below used amount at ${id}`);
    }
    if (next.amount !== req.amount && req.parentId !== null) {
      const delta = next.amount - req.amount;
      if (delta > 0) this._assertChainCapacity(this.chainOf(req.parentId), delta);
    }

    Object.assign(req, next);
    req.version += 1;
    if (req.state === 'active' && patch.policyText !== undefined) {
      this._indexDoc(id, tokenize(req.policyText));
    }
    this._saveState();
    return this._result(req, []);
  }

  get(id) {
    const req = this.requests.get(id);
    if (req === undefined) throw new NotFoundError(`request not found: ${id}`);
    return this._result(req, []);
  }

  query(phrase) {
    const terms = tokenize(phrase);
    if (terms.length === 0) return [];
    const first = this.inverted.get(terms[0]);
    if (first === undefined) return [];
    const results = [];
    for (const [docId, positions] of first) {
      const req = this.requests.get(docId);
      if (req === undefined || req.state !== 'active') continue;
      const matched = positions.some((start) => terms.every((term, offset) => {
        const postings = this.inverted.get(term);
        if (postings === undefined) return false;
        const docPositions = postings.get(docId);
        return docPositions !== undefined && docPositions.includes(start + offset);
      }));
      if (matched) results.push(docId);
    }
    return results.sort();
  }
}

module.exports = {
  Store,
  tokenize,
  QuotaError,
  NotFoundError,
  StaleVersionError,
  StateError,
};
