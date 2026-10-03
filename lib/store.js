import { createHash } from 'node:crypto';
import {
  existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, renameSync,
} from 'node:fs';
import { join } from 'node:path';

const GENESIS = createHash('sha256').update('wallet-hold-store/genesis').digest('hex');

function sha256(...parts) {
  return createHash('sha256').update(parts.join('\n')).digest('hex');
}

export function tokenize(memo) {
  return String(memo).toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

function canonical(value) {
  return JSON.stringify(value, Object.keys(value).sort());
}

/**
 * Open (or create) a hold store rooted at `dir`.
 * Layout: snapshot.json (compacted state) + log.jsonl (commands since snapshot).
 * Every accepted command bumps a global rev and extends a sha256 certificate chain.
 */
export function openStore(dir, { compactThreshold = 100 } = {}) {
  mkdirSync(dir, { recursive: true });
  const snapshotPath = join(dir, 'snapshot.json');
  const logPath = join(dir, 'log.jsonl');

  const state = {
    rev: 0,
    cert: GENESIS,
    seq: 0, // hold id counter
    wallets: new Map(), // wallet -> { available, held }
    holds: new Map(), // id -> { id, wallet, amount, memo, rev, state }
    index: new Map(), // term -> Map(holdId -> [positions])
    tombstones: 0, // cancelled records since... ever (drives compaction)
  };

  function walletOf(name) {
    let w = state.wallets.get(name);
    if (!w) {
      w = { available: 0, held: 0 };
      state.wallets.set(name, w);
    }
    return w;
  }

  function indexAdd(hold) {
    tokenize(hold.memo).forEach((term, pos) => {
      let postings = state.index.get(term);
      if (!postings) {
        postings = new Map();
        state.index.set(term, postings);
      }
      let list = postings.get(hold.id);
      if (!list) {
        list = [];
        postings.set(hold.id, list);
      }
      list.push(pos);
    });
  }

  // ---- replay / persistence --------------------------------------------

  function applyEntry(entry) {
    state.rev = entry.rev;
    state.cert = entry.cert;
    if (entry.op === 'deposit') {
      walletOf(entry.wallet).available += entry.amount;
    } else if (entry.op === 'freeze') {
      const w = walletOf(entry.wallet);
      w.available -= entry.amount;
      w.held += entry.amount;
      const hold = {
        id: entry.id, wallet: entry.wallet, amount: entry.amount,
        memo: entry.memo, rev: entry.rev, state: 'active',
      };
      state.holds.set(hold.id, hold);
      indexAdd(hold);
      const n = Number(entry.id.replace(/^h/, ''));
      if (Number.isInteger(n) && n > state.seq) state.seq = n;
    } else if (entry.op === 'release' || entry.op === 'cancel') {
      const hold = state.holds.get(entry.id);
      const w = walletOf(hold.wallet);
      hold.state = entry.op === 'release' ? 'released' : 'cancelled';
      hold.rev = entry.rev;
      w.held -= hold.amount;
      w.available += hold.amount;
      if (entry.op === 'cancel') state.tombstones += 1;
    }
  }

  function load() {
    if (existsSync(snapshotPath)) {
      const snap = JSON.parse(readFileSync(snapshotPath, 'utf8'));
      state.rev = snap.rev;
      state.cert = snap.cert;
      state.seq = snap.seq;
      state.tombstones = snap.tombstones;
      for (const [name, w] of Object.entries(snap.wallets)) state.wallets.set(name, w);
      for (const hold of snap.holds) {
        state.holds.set(hold.id, hold);
        indexAdd(hold);
      }
    }
    if (existsSync(logPath)) {
      const lines = readFileSync(logPath, 'utf8').split('\n').filter(Boolean);
      let expected = state.rev + 1;
      for (const line of lines) {
        const entry = JSON.parse(line);
        if (entry.rev !== expected) {
          throw new Error(`rev chain broken: expected ${expected}, got ${entry.rev}`);
        }
        applyEntry(entry);
        expected += 1;
      }
    }
  }

  function appendLog(entry) {
    appendFileSync(logPath, JSON.stringify(entry) + '\n');
  }

  function compact() {
    const snap = {
      rev: state.rev,
      cert: state.cert,
      seq: state.seq,
      tombstones: state.tombstones,
      wallets: Object.fromEntries(state.wallets),
      holds: [...state.holds.values()],
    };
    const tmp = join(dir, `snapshot.json.tmp-${process.pid}`);
    writeFileSync(tmp, JSON.stringify(snap));
    renameSync(tmp, snapshotPath);
    writeFileSync(logPath, '');
    return { ok: true, rev: state.rev, cert: state.cert, compacted: true };
  }

  function maybeCompact() {
    if (state.tombstones >= compactThreshold && existsSync(logPath)
        && readFileSync(logPath, 'utf8').length > 0) {
      compact();
    }
  }

  // ---- command helpers ---------------------------------------------------

  function conflict() {
    return { ok: false, error: 'CONFLICT', currentRev: state.rev, cert: state.cert };
  }

  function fail(error) {
    return { ok: false, error, currentRev: state.rev, cert: state.cert };
  }

  function commit(entry) {
    state.rev += 1;
    entry.rev = state.rev;
    entry.cert = sha256(state.cert, String(entry.rev), canonical(entry));
    applyEntry(entry);
    appendLog(entry);
    maybeCompact();
    return entry;
  }

  function checkRev(rev) {
    if (typeof rev !== 'number' || !Number.isInteger(rev)) return fail('BAD_REV');
    if (rev !== state.rev) return conflict();
    return null;
  }

  function validAmount(amount) {
    return typeof amount === 'number' && Number.isFinite(amount) && amount > 0;
  }

  // ---- public commands -----------------------------------------------------

  function deposit({ wallet, amount, rev }) {
    const err = checkRev(rev);
    if (err) return err;
    if (!wallet) return fail('BAD_WALLET');
    if (!validAmount(amount)) return fail('BAD_AMOUNT');
    const entry = commit({ op: 'deposit', wallet, amount });
    const w = walletOf(wallet);
    return { ok: true, rev: entry.rev, wallet, balance: w.available, held: w.held, cert: entry.cert };
  }

  function freeze({ wallet, amount, memo = '', rev, id }) {
    const err = checkRev(rev);
    if (err) return err;
    if (!wallet) return fail('BAD_WALLET');
    if (!validAmount(amount)) return fail('BAD_AMOUNT');
    const w = walletOf(wallet);
    if (w.available < amount) return fail('INSUFFICIENT');
    const holdId = id ?? `h${state.seq + 1}`;
    if (state.holds.has(holdId)) return fail('DUPLICATE_ID');
    const entry = commit({ op: 'freeze', id: holdId, wallet, amount, memo: String(memo) });
    return {
      ok: true, rev: entry.rev, id: holdId, wallet,
      balance: w.available, held: amount, cert: entry.cert,
    };
  }

  function settle(op, { id, rev }) {
    const err = checkRev(rev);
    if (err) return err;
    const hold = state.holds.get(id);
    if (!hold) return fail('NOT_FOUND');
    if (hold.state !== 'active') return fail('NOT_ACTIVE');
    const entry = commit({ op, id });
    const w = walletOf(hold.wallet);
    return {
      ok: true, rev: entry.rev, id, wallet: hold.wallet,
      balance: w.available, released: hold.amount, cert: entry.cert,
    };
  }

  const release = (args) => settle('release', args);
  const cancel = (args) => settle('cancel', args);

  // ---- queries -------------------------------------------------------------

  function balance(wallet) {
    const w = walletOf(wallet);
    return {
      ok: true, wallet, balance: w.available, held: w.held,
      rev: state.rev, cert: state.cert,
    };
  }

  /**
   * Ordered proximity / phrase search over memo positional index.
   * window: max allowed span (last-first+1) covering all query terms in order;
   * defaults to the query term count, i.e. an exact phrase.
   * Cancelled records are hidden unless includeHistory, then annotated.
   */
  function search(query, { window, includeHistory = false } = {}) {
    const terms = tokenize(query);
    if (terms.length === 0) return { ok: true, rev: state.rev, matches: [] };
    const win = window ?? terms.length;
    if (win < terms.length) return fail('WINDOW_TOO_SMALL');
    const postings = terms.map((t) => state.index.get(t));
    if (postings.some((p) => !p)) return { ok: true, rev: state.rev, matches: [] };
    let candidates = new Set(postings[0].keys());
    for (const p of postings.slice(1)) {
      candidates = new Set([...candidates].filter((id) => p.has(id)));
    }
    const matches = [];
    for (const id of candidates) {
      const hold = state.holds.get(id);
      if (!includeHistory && hold.state === 'cancelled') continue;
      const posLists = terms.map((t) => state.index.get(t).get(id));
      if (orderedWithinWindow(posLists, win)) {
        matches.push({
          id: hold.id, wallet: hold.wallet, amount: hold.amount,
          memo: hold.memo, rev: hold.rev, state: hold.state,
          deleted: hold.state === 'cancelled',
        });
      }
    }
    matches.sort((a, b) => (a.id < b.id ? -1 : 1));
    return { ok: true, rev: state.rev, cert: state.cert, window: win, matches };
  }

  function listHolds({ includeHistory = false } = {}) {
    return [...state.holds.values()]
      .filter((h) => includeHistory || h.state !== 'cancelled')
      .map((h) => ({ ...h, deleted: h.state === 'cancelled' }));
  }

  function verify() {
    // Recompute the certificate chain over snapshot tip + log entries.
    let cert = existsSync(snapshotPath)
      ? JSON.parse(readFileSync(snapshotPath, 'utf8')).cert
      : GENESIS;
    let rev = existsSync(snapshotPath)
      ? JSON.parse(readFileSync(snapshotPath, 'utf8')).rev
      : 0;
    if (existsSync(logPath)) {
      for (const line of readFileSync(logPath, 'utf8').split('\n').filter(Boolean)) {
        const entry = JSON.parse(line);
        const { cert: c, ...rest } = entry;
        const r = entry.rev;
        if (r !== rev + 1) return { ok: false, error: 'REV_GAP', atRev: r };
        const expect = sha256(cert, String(r), canonical(rest));
        if (expect !== c) return { ok: false, error: 'CERT_MISMATCH', atRev: r };
        cert = c;
        rev = r;
      }
    }
    return { ok: true, rev, cert };
  }

  load();

  return {
    deposit, freeze, release, cancel,
    balance, search, listHolds, compact, verify,
    get rev() { return state.rev; },
    get cert() { return state.cert; },
    get tombstones() { return state.tombstones; },
  };
}

/** Exists positions p1<...<pn (one per list) with pn - p1 + 1 <= window. */
export function orderedWithinWindow(posLists, window) {
  let current = posLists[0].slice();
  for (const next of posLists.slice(1)) {
    const advanced = [];
    for (const p of current) {
      // smallest position in `next` greater than p
      let lo = 0;
      let hi = next.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (next[mid] > p) hi = mid; else lo = mid + 1;
      }
      if (lo < next.length) advanced.push(next[lo]);
    }
    current = advanced;
    if (current.length === 0) return false;
  }
  // Greedy chain minimises each step; check span of best chain.
  // Recompute the minimal-span chain explicitly:
  const firsts = posLists[0];
  for (const start of firsts) {
    let p = start;
    let okChain = true;
    for (const next of posLists.slice(1)) {
      let lo = 0;
      let hi = next.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (next[mid] > p) hi = mid; else lo = mid + 1;
      }
      if (lo >= next.length) { okChain = false; break; }
      p = next[lo];
    }
    if (okChain && p - start + 1 <= window) return true;
  }
  return false;
}
