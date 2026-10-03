import { createHash } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

export const GENESIS_HASH = '0'.repeat(64);
export const DEFAULT_COMPACT_THRESHOLD = 8;

export function tokenize(text) {
  return String(text).toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

function chainHash(prevHash, event) {
  return createHash('sha256')
    .update(prevHash)
    .update('\n')
    .update(JSON.stringify(event))
    .digest('hex');
}

function assertAmount(amount) {
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new TypeError('amount must be a positive safe integer (minor units)');
  }
}

/**
 * Ordered-window match: each posList is a sorted array of token positions for
 * one query term. Returns true when positions p1 < p2 < ... < pm exist with
 * pm - p1 <= window. A phrase query is window === terms.length - 1.
 */
export function matchWindow(posLists, window) {
  if (posLists.length === 0) return false;
  if (posLists.some((list) => list.length === 0)) return false;
  for (const start of posLists[0]) {
    let prev = start;
    let ok = true;
    for (let i = 1; i < posLists.length; i += 1) {
      const arr = posLists[i];
      let lo = 0;
      let hi = arr.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (arr[mid] > prev) hi = mid;
        else lo = mid + 1;
      }
      if (lo === arr.length) {
        ok = false;
        break;
      }
      prev = arr[lo];
    }
    if (ok && prev - start <= window) return true;
  }
  return false;
}

export class WalletStore {
  /**
   * @param {string} dir data directory (snapshot.json + log.jsonl)
   * @param {{compactThreshold?: number}} [options]
   */
  constructor(dir, options = {}) {
    this.dir = dir;
    this.compactThreshold =
      options.compactThreshold ?? DEFAULT_COMPACT_THRESHOLD;
    this.snapshotPath = join(dir, 'snapshot.json');
    this.logPath = join(dir, 'log.jsonl');

    this.rev = 0;
    this.headHash = GENESIS_HASH;
    this.nextId = 1;
    this.wallets = new Map(); // wallet -> { balance, held }
    this.holds = new Map(); // id -> record
    this.index = new Map(); // term -> Map(holdId -> positions[])
    this.tombstones = 0;

    mkdirSync(dir, { recursive: true });
    this.#load();
  }

  static open(dir, options) {
    return new WalletStore(dir, options);
  }

  // ---------- persistence ----------

  #load() {
    if (existsSync(this.snapshotPath)) {
      const snap = JSON.parse(readFileSync(this.snapshotPath, 'utf8'));
      this.rev = snap.rev;
      this.headHash = snap.hash;
      this.nextId = snap.nextId;
      this.wallets = new Map(
        Object.entries(snap.wallets).map(([name, w]) => [name, { ...w }]),
      );
      this.holds = new Map(snap.holds.map((h) => [h.id, { ...h }]));
      this.tombstones = snap.tombstones ?? 0;
      this.#rebuildIndex();
    }
    if (existsSync(this.logPath)) {
      const lines = readFileSync(this.logPath, 'utf8')
        .split('\n')
        .filter((line) => line.length > 0);
      for (const line of lines) {
        const event = JSON.parse(line);
        if (event.rev !== this.rev + 1) {
          throw new Error(
            `log corruption: expected rev ${this.rev + 1}, got ${event.rev}`,
          );
        }
        if (event.prevHash !== this.headHash) {
          throw new Error(`log corruption: hash chain broken at rev ${event.rev}`);
        }
        const { prevHash, hash, ...body } = event;
        if (chainHash(prevHash, body) !== hash) {
          throw new Error(`log corruption: bad event hash at rev ${event.rev}`);
        }
        this.headHash = hash;
        this.rev = event.rev;
        this.#apply(event);
      }
    }
  }

  #appendLog(event) {
    appendFileSync(this.logPath, `${JSON.stringify(event)}\n`);
  }

  #rebuildIndex() {
    this.index = new Map();
    for (const record of this.holds.values()) {
      if (record.state !== 'cancelled') this.#indexRecord(record);
    }
  }

  #indexRecord(record) {
    tokenize(record.memo).forEach((term, position) => {
      let postings = this.index.get(term);
      if (!postings) {
        postings = new Map();
        this.index.set(term, postings);
      }
      let list = postings.get(record.id);
      if (!list) {
        list = [];
        postings.set(record.id, list);
      }
      list.push(position);
    });
  }

  #unindexRecord(record) {
    for (const term of new Set(tokenize(record.memo))) {
      const postings = this.index.get(term);
      if (!postings) continue;
      postings.delete(record.id);
      if (postings.size === 0) this.index.delete(term);
    }
  }

  // ---------- state transitions ----------

  #wallet(name) {
    let w = this.wallets.get(name);
    if (!w) {
      w = { balance: 0, held: 0 };
      this.wallets.set(name, w);
    }
    return w;
  }

  #apply(event) {
    switch (event.type) {
      case 'deposit': {
        this.#wallet(event.wallet).balance += event.amount;
        break;
      }
      case 'freeze': {
        const w = this.#wallet(event.wallet);
        w.held += event.amount;
        const record = {
          id: event.id,
          wallet: event.wallet,
          amount: event.amount,
          memo: event.memo,
          rev: event.rev,
          state: 'active',
        };
        this.holds.set(record.id, record);
        this.#indexRecord(record);
        break;
      }
      case 'release': {
        const record = this.holds.get(event.id);
        this.#wallet(record.wallet).held -= record.amount;
        record.state = 'released';
        record.rev = event.rev;
        break;
      }
      case 'cancel': {
        const record = this.holds.get(event.id);
        if (record.state === 'active') {
          this.#wallet(record.wallet).held -= record.amount;
        }
        record.state = 'cancelled';
        record.rev = event.rev;
        this.#unindexRecord(record);
        this.tombstones += 1;
        break;
      }
      default:
        throw new Error(`unknown event type: ${event.type}`);
    }
  }

  #commit(type, payload) {
    const rev = this.rev + 1;
    const body = { rev, type, ...payload };
    const hash = chainHash(this.headHash, body);
    const event = { ...body, prevHash: this.headHash, hash };
    this.#appendLog(event);
    this.headHash = hash;
    this.rev = rev;
    this.#apply(event);
    if (this.tombstones >= this.compactThreshold) this.compact();
    return event;
  }

  // ---------- public API ----------

  certificate() {
    return { algorithm: 'sha256-chain', rev: this.rev, hash: this.headHash };
  }

  #conflict(expectedRev) {
    return {
      ok: false,
      code: 'CONFLICT',
      error: `expected rev ${expectedRev} but current rev is ${this.rev}`,
      expectedRev,
      currentRev: this.rev,
      certificate: this.certificate(),
    };
  }

  #failure(code, message) {
    return { ok: false, code, error: message, currentRev: this.rev };
  }

  #checkRev(expectedRev) {
    if (!Number.isSafeInteger(expectedRev)) {
      return this.#failure('BAD_REV', 'expectedRev must be an integer');
    }
    if (expectedRev !== this.rev) return this.#conflict(expectedRev);
    return null;
  }

  #success(extra) {
    const out = { ok: true, rev: this.rev, certificate: this.certificate(), ...extra };
    if (extra.wallet !== undefined) {
      const w = this.#wallet(extra.wallet);
      out.balance = w.balance;
      out.held = w.held;
      out.available = w.balance - w.held;
    }
    return out;
  }

  balance(wallet) {
    const w = this.#wallet(wallet);
    return {
      ok: true,
      wallet,
      balance: w.balance,
      held: w.held,
      available: w.balance - w.held,
      rev: this.rev,
      certificate: this.certificate(),
    };
  }

  deposit({ wallet, amount, expectedRev }) {
    const rejected = this.#checkRev(expectedRev);
    if (rejected) return rejected;
    try {
      assertAmount(amount);
    } catch (err) {
      return this.#failure('BAD_AMOUNT', err.message);
    }
    this.#commit('deposit', { wallet, amount });
    return this.#success({ wallet, amount });
  }

  freeze({ wallet, amount, memo = '', expectedRev }) {
    const rejected = this.#checkRev(expectedRev);
    if (rejected) return rejected;
    try {
      assertAmount(amount);
    } catch (err) {
      return this.#failure('BAD_AMOUNT', err.message);
    }
    const w = this.#wallet(wallet);
    if (w.balance - w.held < amount) {
      return this.#failure(
        'INSUFFICIENT_FUNDS',
        `available ${w.balance - w.held} < requested ${amount}`,
      );
    }
    const id = `hold-${this.nextId}`;
    this.#commit('freeze', { id, wallet, amount, memo: String(memo) });
    this.nextId += 1;
    return this.#success({ id, wallet, amount, memo: String(memo) });
  }

  release({ id, expectedRev }) {
    const rejected = this.#checkRev(expectedRev);
    if (rejected) return rejected;
    const record = this.holds.get(id);
    if (!record) return this.#failure('NOT_FOUND', `no such hold: ${id}`);
    if (record.state !== 'active') {
      return this.#failure('BAD_STATE', `hold ${id} is ${record.state}`);
    }
    this.#commit('release', { id });
    return this.#success({
      id,
      wallet: record.wallet,
      amount: record.amount,
      state: 'released',
    });
  }

  cancel({ id, expectedRev }) {
    const rejected = this.#checkRev(expectedRev);
    if (rejected) return rejected;
    const record = this.holds.get(id);
    if (!record) return this.#failure('NOT_FOUND', `no such hold: ${id}`);
    if (record.state === 'cancelled') {
      return this.#failure('BAD_STATE', `hold ${id} already cancelled`);
    }
    this.#commit('cancel', { id });
    return this.#success({
      id,
      wallet: record.wallet,
      amount: record.amount,
      state: 'cancelled',
    });
  }

  /**
   * Phrase / ordered-proximity search over hold memos.
   * @param {string} query whitespace-separated terms
   * @param {{near?: number, includeHistory?: boolean}} [options]
   *   near: ordered window width (span of first..last matched term). Omit for
   *   exact phrase. includeHistory: also scan logically deleted records.
   */
  search(query, options = {}) {
    const terms = tokenize(query);
    if (terms.length === 0) {
      return { ok: true, rev: this.rev, terms, window: 0, results: [] };
    }
    const window = options.near ?? terms.length - 1;
    if (!Number.isSafeInteger(window) || window < terms.length - 1) {
      return this.#failure(
        'BAD_WINDOW',
        `near window must be an integer >= ${terms.length - 1}`,
      );
    }

    const results = [];
    if (options.includeHistory) {
      // Full enumeration over every record, deleted included.
      for (const record of this.holds.values()) {
        const tokens = tokenize(record.memo);
        const posLists = terms.map((term) =>
          tokens.flatMap((tok, i) => (tok === term ? [i] : [])),
        );
        if (matchWindow(posLists, window)) results.push(record);
      }
    } else {
      // Positional index lookup over live (non-deleted) records only.
      let candidateIds = null;
      const postingsByTerm = [];
      for (const term of terms) {
        const postings = this.index.get(term);
        if (!postings) {
          candidateIds = new Set();
          postingsByTerm.length = 0;
          break;
        }
        postingsByTerm.push(postings);
        const ids = new Set(postings.keys());
        candidateIds =
          candidateIds === null
            ? ids
            : new Set([...candidateIds].filter((id) => ids.has(id)));
      }
      for (const id of candidateIds) {
        const posLists = postingsByTerm.map((postings) => postings.get(id));
        if (matchWindow(posLists, window)) {
          results.push(this.holds.get(id));
        }
      }
    }

    results.sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }));
    return {
      ok: true,
      rev: this.rev,
      terms,
      window,
      includeHistory: Boolean(options.includeHistory),
      results: results.map((r) => ({
        id: r.id,
        wallet: r.wallet,
        amount: r.amount,
        memo: r.memo,
        rev: r.rev,
        state: r.state,
        deleted: r.state === 'cancelled',
      })),
    };
  }

  /** Incremental compaction: fold live state into a snapshot, truncate log. */
  compact() {
    const snapshot = {
      rev: this.rev,
      hash: this.headHash,
      nextId: this.nextId,
      wallets: Object.fromEntries(this.wallets),
      holds: [...this.holds.values()],
      tombstones: 0,
    };
    const tmp = `${this.snapshotPath}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(snapshot, null, 2)}\n`);
    renameSync(tmp, this.snapshotPath);
    writeFileSync(this.logPath, '');
    this.tombstones = 0;
    return { ok: true, rev: this.rev, certificate: this.certificate() };
  }

  /** All records (including deleted) — introspection helper for tests/CLI. */
  records() {
    return [...this.holds.values()].map((r) => ({ ...r }));
  }
}
