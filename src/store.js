import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const STATE = Object.freeze({
  ACTIVE: 'active',
  REVOKED: 'revoked',
  EXPIRED: 'expired',
});

export class StoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'StoreError';
    this.code = code;
  }
}

export function tokenize(text) {
  return String(text ?? '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

function hashRecord(g, parentHash) {
  return createHash('sha256')
    .update(
      JSON.stringify([
        g.id,
        g.parentId,
        g.exposure,
        g.cap,
        g.terms,
        g.expiresAt,
        parentHash ?? null,
      ]),
    )
    .digest('hex');
}

function isFiniteNumber(n) {
  return typeof n === 'number' && Number.isFinite(n);
}

export class GuaranteeStore {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, 'store.json');
    this.guarantees = new Map(); // id -> record
    this.children = new Map(); // id -> Set(childId)
    this.used = new Map(); // id -> live exposure of subtree (incl. self)
    this.index = new Map(); // term -> Map(gid -> [positions])
    this.deleted = new Set(); // logically deleted gids (revoked/expired)
    this._load();
  }

  // ---------- persistence ----------

  _load() {
    if (!fs.existsSync(this.file)) return;
    const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    for (const g of raw.guarantees) {
      this.guarantees.set(g.id, g);
      if (!this.children.has(g.id)) this.children.set(g.id, new Set());
      if (g.parentId !== null) {
        if (!this.children.has(g.parentId)) this.children.set(g.parentId, new Set());
        this.children.get(g.parentId).add(g.id);
      }
      if (g.state !== STATE.ACTIVE) this.deleted.add(g.id);
    }
    // rebuild used (bottom-up via ancestor walks) and the terms index
    for (const g of this.guarantees.values()) this.used.set(g.id, 0);
    for (const g of this.guarantees.values()) {
      if (g.state === STATE.ACTIVE) {
        let cur = g;
        while (cur) {
          this.used.set(cur.id, (this.used.get(cur.id) ?? 0) + g.exposure);
          cur = cur.parentId ? this.guarantees.get(cur.parentId) : null;
        }
      }
      this._indexAdd(g.id, g.terms);
    }
  }

  _persist() {
    fs.mkdirSync(this.dir, { recursive: true });
    const payload = JSON.stringify(
      { version: 1, guarantees: [...this.guarantees.values()] },
      null,
      2,
    );
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, payload);
    fs.renameSync(tmp, this.file); // atomic replace
  }

  // ---------- index maintenance ----------

  _indexAdd(gid, terms) {
    tokenize(terms).forEach((term, pos) => {
      let posting = this.index.get(term);
      if (!posting) {
        posting = new Map();
        this.index.set(term, posting);
      }
      let list = posting.get(gid);
      if (!list) {
        list = [];
        posting.set(gid, list);
      }
      list.push(pos);
    });
  }

  _indexRemove(gid) {
    // incremental compaction: drop this doc's postings, prune empty terms
    for (const [term, posting] of this.index) {
      if (posting.delete(gid) && posting.size === 0) this.index.delete(term);
    }
  }

  // ---------- helpers ----------

  _get(id) {
    const g = this.guarantees.get(id);
    if (!g) throw new StoreError('NOT_FOUND', `guarantee not found: ${id}`);
    return g;
  }

  *_ancestorsOf(g) {
    // yields node itself, then parent, ... up to the root
    let cur = g;
    while (cur) {
      yield cur;
      cur = cur.parentId ? this.guarantees.get(cur.parentId) : null;
    }
  }

  _release(g) {
    for (const node of this._ancestorsOf(g)) {
      this.used.set(node.id, (this.used.get(node.id) ?? 0) - g.exposure);
    }
  }

  _subtreeIds(id) {
    const out = [];
    const stack = [id];
    while (stack.length) {
      const cur = stack.pop();
      out.push(cur);
      for (const c of this.children.get(cur) ?? []) stack.push(c);
    }
    return out;
  }

  // ---------- mutations (validate fully, then mutate, then persist) ----------

  issue({ id, parentId = null, exposure, cap, terms = '', expiresAt, now = Date.now() }) {
    id = id ?? randomUUID();
    if (this.guarantees.has(id)) {
      throw new StoreError('DUPLICATE_ID', `duplicate id: ${id}`);
    }
    if (!isFiniteNumber(exposure) || exposure < 0) {
      throw new StoreError('INVALID_EXPOSURE', `exposure must be a number >= 0, got ${exposure}`);
    }
    if (!isFiniteNumber(cap) || cap < 0) {
      throw new StoreError('INVALID_CAP', `cap must be a number >= 0, got ${cap}`);
    }
    if (!isFiniteNumber(expiresAt)) {
      throw new StoreError('INVALID_EXPIRY', `expiresAt must be epoch ms, got ${expiresAt}`);
    }
    if (expiresAt <= now) {
      throw new StoreError('ALREADY_EXPIRED', `expiresAt ${expiresAt} is not in the future (now=${now})`);
    }
    if (exposure > cap) {
      throw new StoreError('OVER_LIMIT', `exposure ${exposure} exceeds own cap ${cap}`);
    }
    let parent = null;
    if (parentId !== null) {
      parent = this.guarantees.get(parentId);
      if (!parent) throw new StoreError('PARENT_NOT_FOUND', `parent not found: ${parentId}`);
      if (parent.state !== STATE.ACTIVE) {
        throw new StoreError('PARENT_NOT_ACTIVE', `parent ${parentId} is ${parent.state}`);
      }
    }
    // capacity check along the whole parent chain (freeze at every level)
    if (parent) {
      for (const node of this._ancestorsOf(parent)) {
        const used = this.used.get(node.id) ?? 0;
        if (used + exposure > node.cap) {
          throw new StoreError(
            'OVER_LIMIT',
            `level ${node.id}: used ${used} + exposure ${exposure} exceeds cap ${node.cap}`,
          );
        }
      }
    }
    // all validation passed -> mutate
    const record = {
      id,
      parentId,
      exposure,
      cap,
      terms: String(terms),
      expiresAt,
      state: STATE.ACTIVE,
      createdAt: now,
      hash: hashRecord(
        { id, parentId, exposure, cap, terms: String(terms), expiresAt },
        parent ? parent.hash : null,
      ),
    };
    this.guarantees.set(id, record);
    if (!this.children.has(id)) this.children.set(id, new Set());
    if (parent) this.children.get(parent.id).add(id);
    this.used.set(id, exposure);
    if (parent) {
      for (const node of this._ancestorsOf(parent)) {
        this.used.set(node.id, (this.used.get(node.id) ?? 0) + exposure);
      }
    }
    this._indexAdd(id, record.terms);
    this._persist();
    return record;
  }

  revoke(id, now = Date.now()) {
    const g = this._get(id);
    if (g.state === STATE.REVOKED) {
      throw new StoreError('ALREADY_REVOKED', `guarantee ${id} already revoked`);
    }
    if (g.state !== STATE.ACTIVE) {
      throw new StoreError('NOT_ACTIVE', `guarantee ${id} is ${g.state}`);
    }
    g.state = STATE.REVOKED;
    g.stateChangedAt = now;
    this.deleted.add(id);
    this._release(g);
    this._persist();
    return g;
  }

  // mark every active guarantee with expiresAt <= now as expired (logical delete)
  sweep(now = Date.now()) {
    const expired = [];
    for (const g of this.guarantees.values()) {
      if (g.state === STATE.ACTIVE && g.expiresAt <= now) expired.push(g);
    }
    for (const g of expired) {
      g.state = STATE.EXPIRED;
      g.stateChangedAt = now;
      this.deleted.add(g.id);
      this._release(g);
    }
    if (expired.length) this._persist();
    return expired.map((g) => g.id);
  }

  // physical delete of a dead subtree; refuses while any descendant is live
  purge(id) {
    const g = this._get(id);
    if (g.state === STATE.ACTIVE) {
      throw new StoreError('NOT_PURGEABLE', `guarantee ${id} is still active`);
    }
    const ids = this._subtreeIds(id);
    const live = ids.filter((sid) => this.guarantees.get(sid).state === STATE.ACTIVE);
    if (live.length) {
      throw new StoreError('LIVE_DESCENDANTS', `cannot purge ${id}: live descendants ${live.join(', ')}`);
    }
    for (const sid of ids) {
      this._indexRemove(sid);
      this.deleted.delete(sid);
      this.used.delete(sid);
      this.guarantees.delete(sid);
      this.children.delete(sid);
    }
    if (g.parentId !== null && this.children.has(g.parentId)) {
      this.children.get(g.parentId).delete(id);
    }
    this._persist();
    return ids;
  }

  // ---------- queries ----------

  _livePostings(term) {
    const posting = this.index.get(term);
    if (!posting) return new Map();
    return new Map([...posting].filter(([gid]) => !this.deleted.has(gid)));
  }

  phraseQuery(phrase) {
    const terms = tokenize(phrase);
    if (!terms.length) return [];
    const first = this._livePostings(terms[0]);
    const results = [];
    for (const [gid, positions] of first) {
      const hits = [];
      for (const p of positions) {
        let ok = true;
        for (let i = 1; i < terms.length; i++) {
          const posting = this.index.get(terms[i]);
          const list = posting ? posting.get(gid) : undefined;
          if (!list || !list.includes(p + i)) {
            ok = false;
            break;
          }
        }
        if (ok) hits.push(p);
      }
      if (hits.length) results.push({ id: gid, positions: hits });
    }
    return results.sort((a, b) => (a.id < b.id ? -1 : 1));
  }

  // ordered proximity: positions p1 < p2 < ... < pm with pm - p1 <= window
  nearQuery(terms, window = 5) {
    const norm = terms.map((t) => tokenize(t)[0]).filter(Boolean);
    if (norm.length < 2) throw new StoreError('INVALID_QUERY', 'nearQuery needs >= 2 terms');
    const postings = norm.map((t) => this._livePostings(t));
    const gids = [...postings[0].keys()].filter((gid) => postings.every((p) => p.has(gid)));
    const results = [];
    for (const gid of gids) {
      const lists = postings.map((p) => p.get(gid));
      const windows = new Set();
      const walk = (level, min, acc) => {
        if (level === lists.length) {
          windows.add(`${acc[0]}-${acc[acc.length - 1]}`);
          return;
        }
        for (const pos of lists[level]) {
          if (pos <= min) continue;
          if (pos - acc[0] > window) break; // lists are ascending
          walk(level + 1, pos, [...acc, pos]);
        }
      };
      for (const p1 of lists[0]) walk(1, p1, [p1]);
      if (windows.size) {
        results.push({
          id: gid,
          windows: [...windows].map((w) => w.split('-').map(Number)).sort((a, b) => a[0] - b[0] || a[1] - b[1]),
        });
      }
    }
    return results.sort((a, b) => (a.id < b.id ? -1 : 1));
  }

  // ---------- audit & verification ----------

  audit(id, query) {
    const g = this._get(id);
    const chain = [];
    let cur = g;
    while (cur) {
      chain.unshift(cur);
      cur = cur.parentId ? this.guarantees.get(cur.parentId) : null;
    }
    let parentHash = null;
    let valid = true;
    const pathInfo = chain.map((node) => {
      const recomputed = hashRecord(node, parentHash);
      if (recomputed !== node.hash) valid = false;
      parentHash = node.hash;
      const used = this.used.get(node.id) ?? 0;
      return {
        id: node.id,
        state: node.state,
        exposure: node.exposure,
        cap: node.cap,
        used,
        remaining: node.cap - used,
        hash: node.hash,
      };
    });
    let hits = null;
    if (query !== undefined && query !== null) {
      const docTokens = tokenize(g.terms);
      hits = {};
      for (const qt of tokenize(query)) {
        hits[qt] = docTokens.flatMap((t, i) => (t === qt ? [i] : []));
      }
    }
    return {
      guaranteeId: id,
      generatedAt: Date.now(),
      path: pathInfo,
      hits,
      chainHash: g.hash,
      valid,
    };
  }

  remaining(id) {
    const g = this._get(id);
    return g.cap - (this.used.get(id) ?? 0);
  }

  // independent recomputation: subtree sums, hash chain, index consistency
  verify() {
    const problems = [];
    const expectedUsed = new Map([...this.guarantees.keys()].map((id) => [id, 0]));
    for (const g of this.guarantees.values()) {
      if (g.state !== STATE.ACTIVE) continue;
      let cur = g;
      while (cur) {
        expectedUsed.set(cur.id, expectedUsed.get(cur.id) + g.exposure);
        cur = cur.parentId ? this.guarantees.get(cur.parentId) : null;
      }
    }
    for (const [id, expected] of expectedUsed) {
      const actual = this.used.get(id) ?? 0;
      if (actual !== expected) {
        problems.push(`used mismatch at ${id}: incremental=${actual} traversal=${expected}`);
      }
    }
    for (const g of this.guarantees.values()) {
      const parent = g.parentId ? this.guarantees.get(g.parentId) : null;
      if (g.parentId !== null && !parent) problems.push(`dangling parent ${g.parentId} of ${g.id}`);
      const recomputed = hashRecord(g, parent ? parent.hash : null);
      if (recomputed !== g.hash) problems.push(`hash mismatch at ${g.id}`);
    }
    for (const g of this.guarantees.values()) {
      const shouldBeDeleted = g.state !== STATE.ACTIVE;
      if (this.deleted.has(g.id) !== shouldBeDeleted) {
        problems.push(`deleted-flag mismatch at ${g.id}`);
      }
    }
    for (const [term, posting] of this.index) {
      for (const [gid, positions] of posting) {
        const g = this.guarantees.get(gid);
        if (!g) {
          problems.push(`stale posting ${term} -> ${gid}`);
          continue;
        }
        const expected = tokenize(g.terms).flatMap((t, i) => (t === term ? [i] : []));
        if (JSON.stringify(expected) !== JSON.stringify([...positions].sort((a, b) => a - b))) {
          problems.push(`posting mismatch ${term} -> ${gid}`);
        }
      }
    }
    return { ok: problems.length === 0, problems };
  }

  postingCount() {
    let n = 0;
    for (const posting of this.index.values()) n += posting.size;
    return n;
  }
}
