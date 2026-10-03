import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { TextIndex } from './text-index.js';

export const STATE = Object.freeze({
  ACTIVE: 'ACTIVE',
  REVOKED: 'REVOKED',
  EXPIRED: 'EXPIRED',
});

export class GuaranteeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'GuaranteeError';
    this.code = code;
  }
}

const sha256 = (input) => createHash('sha256').update(input).digest('hex');

function canonicalImmutable(rec) {
  return JSON.stringify({
    id: rec.id,
    parentId: rec.parentId,
    exposure: rec.exposure,
    cap: rec.cap,
    terms: rec.terms,
    expiresAt: rec.expiresAt,
  });
}

function chainHashOf(parentHash, rec) {
  return sha256(`${parentHash ?? 'GENESIS'}|${canonicalImmutable(rec)}`);
}

function serializeRecord(rec) {
  return {
    id: rec.id,
    parentId: rec.parentId,
    exposure: rec.exposure,
    cap: rec.cap,
    terms: rec.terms,
    expiresAt: rec.expiresAt,
    state: rec.state,
    used: rec.used,
    chainHash: rec.chainHash,
  };
}

function parseTime(value, code) {
  const ts = value instanceof Date ? value.getTime() : Date.parse(value);
  if (Number.isNaN(ts)) {
    throw new GuaranteeError(code, `unparseable time: ${value}`);
  }
  return ts;
}

function sortedObject(map) {
  return Object.fromEntries(
    [...map.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
}

export class GuaranteeChain {
  #guarantees = new Map();
  #index = new TextIndex();
  #file = null;

  constructor({ dataDir = null } = {}) {
    this.#file = dataDir ? join(dataDir, 'state.json') : null;
  }

  static load({ dataDir }) {
    const chain = new GuaranteeChain({ dataDir });
    const file = join(dataDir, 'state.json');
    if (!existsSync(file)) return chain;
    const doc = JSON.parse(readFileSync(file, 'utf8'));
    const payload = JSON.stringify({ version: doc.version, guarantees: doc.guarantees });
    if (sha256(payload) !== doc.checksum) {
      throw new GuaranteeError('CHECKSUM_MISMATCH', 'state file checksum mismatch');
    }
    for (const rec of doc.guarantees) {
      chain.#guarantees.set(rec.id, { ...rec });
      chain.#index.add(rec.id, rec.terms);
    }
    const report = chain.verify();
    if (!report.ok) {
      throw new GuaranteeError(
        'INTEGRITY_FAILURE',
        `state failed verification: ${report.problems.join('; ')}`,
      );
    }
    return chain;
  }

  get stateFile() {
    return this.#file;
  }

  get(id) {
    const rec = this.#guarantees.get(id);
    return rec ? serializeRecord(rec) : undefined;
  }

  list() {
    return [...this.#guarantees.values()].map(serializeRecord);
  }

  remaining(id) {
    const rec = this.#require(id);
    return rec.cap - rec.used;
  }

  snapshot() {
    return JSON.stringify(this.list());
  }

  indexStats() {
    return { terms: this.#index.termCount, docs: this.#index.docCount };
  }

  postingsOf(term) {
    return this.#index.postings(term);
  }

  issue({ id, parentId = null, exposure, cap, terms = '', expiresAt }) {
    if (typeof id !== 'string' || id.length === 0) {
      throw new GuaranteeError('INVALID_ID', 'id must be a non-empty string');
    }
    if (this.#guarantees.has(id)) {
      throw new GuaranteeError('DUPLICATE_ID', `guarantee ${id} already exists`);
    }
    if (!Number.isFinite(exposure) || exposure <= 0) {
      throw new GuaranteeError('INVALID_EXPOSURE', `exposure must be a positive finite number, got ${exposure}`);
    }
    if (!Number.isFinite(cap) || cap < 0) {
      throw new GuaranteeError('INVALID_CAP', `cap must be a non-negative finite number, got ${cap}`);
    }
    const expiresTs = parseTime(expiresAt, 'INVALID_EXPIRY');

    let parent = null;
    const ancestors = [];
    if (parentId !== null && parentId !== undefined) {
      parent = this.#guarantees.get(parentId);
      if (!parent) {
        throw new GuaranteeError('PARENT_NOT_FOUND', `parent guarantee ${parentId} does not exist`);
      }
      if (parent.state !== STATE.ACTIVE) {
        throw new GuaranteeError('PARENT_INACTIVE', `parent guarantee ${parentId} is ${parent.state}`);
      }
      let cursor = parent;
      while (cursor) {
        ancestors.push(cursor);
        cursor = cursor.parentId ? this.#guarantees.get(cursor.parentId) : null;
      }
      for (const ancestor of ancestors) {
        if (ancestor.used + exposure > ancestor.cap) {
          throw new GuaranteeError(
            'OVER_CAP',
            `issuing ${id} with exposure ${exposure} exceeds remaining capacity of ${ancestor.id} (cap ${ancestor.cap}, used ${ancestor.used})`,
          );
        }
      }
    }

    const rec = {
      id,
      parentId: parentId ?? null,
      exposure,
      cap,
      terms: String(terms),
      expiresAt: new Date(expiresTs).toISOString(),
      state: STATE.ACTIVE,
      used: 0,
      chainHash: null,
    };
    rec.chainHash = chainHashOf(parent ? parent.chainHash : null, rec);

    for (const ancestor of ancestors) ancestor.used += exposure;
    this.#guarantees.set(id, rec);
    this.#index.add(id, rec.terms);
    this.#save();
    return serializeRecord(rec);
  }

  revoke(id) {
    const rec = this.#require(id);
    if (rec.state !== STATE.ACTIVE) {
      throw new GuaranteeError('INVALID_STATE', `cannot revoke ${id}: state is ${rec.state}`);
    }
    rec.state = STATE.REVOKED;
    this.#release(rec);
    this.#save();
    return serializeRecord(rec);
  }

  expire(id, now = new Date()) {
    const rec = this.#require(id);
    if (rec.state !== STATE.ACTIVE) {
      throw new GuaranteeError('INVALID_STATE', `cannot expire ${id}: state is ${rec.state}`);
    }
    const nowTs = parseTime(now, 'INVALID_NOW');
    if (nowTs < Date.parse(rec.expiresAt)) {
      throw new GuaranteeError('NOT_EXPIRED', `guarantee ${id} expires at ${rec.expiresAt}`);
    }
    rec.state = STATE.EXPIRED;
    this.#release(rec);
    this.#save();
    return serializeRecord(rec);
  }

  purge(id, now = new Date()) {
    const rec = this.#require(id);
    if (rec.state === STATE.ACTIVE) {
      throw new GuaranteeError('STILL_ACTIVE', `cannot purge ${id}: guarantee is still ACTIVE`);
    }
    const nowTs = parseTime(now, 'INVALID_NOW');
    if (nowTs < Date.parse(rec.expiresAt)) {
      throw new GuaranteeError('NOT_EXPIRED', `cannot purge ${id}: not overdue until ${rec.expiresAt}`);
    }
    for (const g of this.#guarantees.values()) {
      if (g.parentId === id) {
        throw new GuaranteeError('HAS_LIVE_CHILDREN', `cannot purge ${id}: child ${g.id} is still in the store`);
      }
    }
    this.#guarantees.delete(id);
    this.#index.remove(id);
    this.#save();
    return { purged: id };
  }

  queryPhrase(phrase) {
    return sortedObject(this.#index.phrase(phrase));
  }

  queryNear(termA, termB, k) {
    return sortedObject(this.#index.near(termA, termB, k));
  }

  audit(id, query = null) {
    const rec = this.#require(id);
    const path = [];
    let cursor = rec;
    while (cursor) {
      path.unshift(cursor);
      cursor = cursor.parentId ? this.#guarantees.get(cursor.parentId) : null;
    }
    let verified = true;
    let previousHash = null;
    const levels = path.map((g) => {
      if (chainHashOf(previousHash, g) !== g.chainHash) verified = false;
      previousHash = g.chainHash;
      return {
        id: g.id,
        state: g.state,
        exposure: g.exposure,
        cap: g.cap,
        used: g.used,
        remaining: g.cap - g.used,
        chainHash: g.chainHash,
      };
    });
    let hits = null;
    if (query?.phrase) {
      hits = { phrase: this.#index.phrase(query.phrase).get(id) ?? [] };
    } else if (query?.near) {
      const [termA, termB] = query.near.terms;
      hits = { near: this.#index.near(termA, termB, query.near.k).get(id) ?? [] };
    }
    return { id, path: levels, hits, chainHash: rec.chainHash, verified };
  }

  verify() {
    const problems = [];
    for (const g of this.#guarantees.values()) {
      if (g.parentId !== null && !this.#guarantees.has(g.parentId)) {
        problems.push(`dangling parent ${g.parentId} of ${g.id}`);
      }
    }
    const used = new Map([...this.#guarantees.keys()].map((id) => [id, 0]));
    for (const g of this.#guarantees.values()) {
      if (g.state !== STATE.ACTIVE) continue;
      let cursor = g.parentId ? this.#guarantees.get(g.parentId) : null;
      while (cursor) {
        used.set(cursor.id, used.get(cursor.id) + g.exposure);
        cursor = cursor.parentId ? this.#guarantees.get(cursor.parentId) : null;
      }
    }
    for (const [id, expected] of used) {
      const g = this.#guarantees.get(id);
      if (g.used !== expected) {
        problems.push(`used mismatch for ${id}: stored ${g.used}, computed ${expected}`);
      }
      if (expected > g.cap) {
        problems.push(`cap exceeded for ${id}: used ${expected} > cap ${g.cap}`);
      }
    }
    const memo = new Map();
    const computeHash = (g) => {
      if (memo.has(g.id)) return memo.get(g.id);
      const parentHash = g.parentId ? computeHash(this.#guarantees.get(g.parentId)) : null;
      const hash = chainHashOf(parentHash, g);
      memo.set(g.id, hash);
      return hash;
    };
    for (const g of this.#guarantees.values()) {
      if (computeHash(g) !== g.chainHash) {
        problems.push(`chain hash mismatch for ${g.id}`);
      }
    }
    const rebuilt = new TextIndex();
    for (const g of this.#guarantees.values()) rebuilt.add(g.id, g.terms);
    if (!this.#index.equals(rebuilt)) {
      problems.push('terms position index mismatch');
    }
    return { ok: problems.length === 0, problems };
  }

  #require(id) {
    const rec = this.#guarantees.get(id);
    if (!rec) {
      throw new GuaranteeError('NOT_FOUND', `guarantee ${id} does not exist`);
    }
    return rec;
  }

  #release(rec) {
    let cursor = rec.parentId ? this.#guarantees.get(rec.parentId) : null;
    while (cursor) {
      cursor.used -= rec.exposure;
      cursor = cursor.parentId ? this.#guarantees.get(cursor.parentId) : null;
    }
  }

  #save() {
    if (!this.#file) return;
    const guarantees = [...this.#guarantees.values()].map(serializeRecord);
    const doc = { version: 1, guarantees };
    doc.checksum = sha256(JSON.stringify({ version: doc.version, guarantees }));
    mkdirSync(dirname(this.#file), { recursive: true });
    const tmp = `${this.#file}.tmp`;
    writeFileSync(tmp, JSON.stringify(doc, null, 2));
    renameSync(tmp, this.#file);
  }
}
