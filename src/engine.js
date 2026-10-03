'use strict';

const crypto = require('crypto');
const { AhoCorasick } = require('./aho');
const { RegexDFA } = require('./dfa');

const MAX_LINES = 100000;
const MAX_EXACT_RULES = 5000;
const FIELDS = ['clearingNo', 'counterparty', 'currency', 'amount', 'memo'];

class ScanError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function makeHit(line, field, start, length, ruleId, kind, match, traceHash) {
  // Fixed key order: proofs compare canonical JSON of hit arrays.
  return { line, field, start, length, ruleId, kind, match, traceHash };
}

// Unified hit ordering: start, then length, then rule id
// (line and field are deterministic pre-keys / tie-breakers).
function compareHits(a, b) {
  return a.line - b.line
    || a.start - b.start
    || a.length - b.length
    || (a.ruleId < b.ruleId ? -1 : a.ruleId > b.ruleId ? 1 : 0)
    || (a.field < b.field ? -1 : a.field > b.field ? 1 : 0);
}

class Engine {
  constructor(rules) {
    const exact = rules.exact || [];
    const regex = rules.regex || [];
    if (exact.length > MAX_EXACT_RULES) {
      throw new ScanError('OFFSET_OVERFLOW', `exact rule count ${exact.length} exceeds ${MAX_EXACT_RULES}`);
    }
    const ids = new Set();
    const patterns = new Set();
    for (const r of exact) {
      if (!r || typeof r.id !== 'string' || typeof r.pattern !== 'string' || r.pattern.length === 0) {
        throw new ScanError('BAD_RULE', 'exact rules need non-empty string id and pattern');
      }
      if (ids.has(r.id)) throw new ScanError('DUP_RULE', `duplicate rule id '${r.id}'`);
      if (patterns.has(r.pattern)) throw new ScanError('DUP_RULE', `duplicate exact pattern '${r.pattern}'`);
      ids.add(r.id);
      patterns.add(r.pattern);
    }
    for (const r of regex) {
      if (!r || typeof r.id !== 'string' || typeof r.pattern !== 'string') {
        throw new ScanError('BAD_RULE', 'regex rules need string id and pattern');
      }
      if (ids.has(r.id)) throw new ScanError('DUP_RULE', `duplicate rule id '${r.id}'`);
      if (!FIELDS.includes(r.field)) throw new ScanError('BAD_RULE', `unknown field '${r.field}'`);
      ids.add(r.id);
    }
    this.rules = { exact, regex };
    this.rulesHash = sha256(JSON.stringify({ exact, regex }));
    this.ac = new AhoCorasick(exact);
    this.dfas = regex.map((r) => ({ id: r.id, field: r.field, dfa: new RegexDFA(r.pattern) }));
    this.lines = [];
    this.lineHashes = [];
    this.lineHits = [];
  }

  load(lines) {
    if (lines.length > MAX_LINES) {
      throw new ScanError('OFFSET_OVERFLOW', `line count ${lines.length} exceeds ${MAX_LINES}`);
    }
    this.lines = lines.slice();
    this.lineHashes = this.lines.map((l) => sha256(l));
    this.lineHits = this.lines.map((_, i) => this._scanLine(i));
  }

  _fieldText(rec, field) {
    const v = rec[field];
    return v === undefined || v === null ? '' : String(v);
  }

  _scanLine(idx) {
    let rec;
    try {
      rec = JSON.parse(this.lines[idx]);
    } catch {
      throw new ScanError('BAD_RECORD', `line ${idx}: invalid JSON record`);
    }
    if (rec === null || typeof rec !== 'object' || Array.isArray(rec)) {
      throw new ScanError('BAD_RECORD', `line ${idx}: record must be a JSON object`);
    }
    const hits = [];
    const memo = this._fieldText(rec, 'memo');
    const acRes = this.ac.scan(memo);
    for (const h of acRes.hits) {
      const trace = acRes.states.slice(h.start, h.start + h.length + 1);
      hits.push(makeHit(idx, 'memo', h.start, h.length, h.ruleId, 'exact',
        memo.slice(h.start, h.start + h.length), sha256(JSON.stringify(trace))));
    }
    for (const { id, field, dfa } of this.dfas) {
      const text = this._fieldText(rec, field);
      for (let i = 0; i < text.length; i++) {
        const m = dfa.matchFrom(text, i);
        if (m) {
          hits.push(makeHit(idx, field, i, m.length, id, 'regex',
            text.slice(i, i + m.length), sha256(JSON.stringify(m.trace))));
        }
      }
    }
    hits.sort(compareHits);
    return hits;
  }

  _rootHash() {
    return sha256(this.lineHashes.join(''));
  }

  _contextHash(exclude) {
    let acc = '';
    for (let i = 0; i < this.lineHashes.length; i++) {
      if (i !== exclude) acc += this.lineHashes[i];
    }
    return sha256(acc);
  }

  // Replace exactly one line and rescan only the affected window [lineNo, lineNo].
  // Returns an interval proof: window bounds, before/after line+root hashes and a
  // context hash over all lines outside the window (must be identical before/after).
  patch(lineNo, text) {
    if (!Number.isInteger(lineNo) || lineNo < 0 || lineNo >= this.lines.length) {
      throw new ScanError('BAD_PATCH', `patch line ${lineNo} out of range [0, ${this.lines.length})`);
    }
    let rec;
    try {
      rec = JSON.parse(text);
    } catch {
      throw new ScanError('BAD_PATCH', 'replacement text is not valid JSON');
    }
    if (rec === null || typeof rec !== 'object' || Array.isArray(rec)) {
      throw new ScanError('BAD_PATCH', 'replacement record must be a JSON object');
    }
    const before = { lineHash: this.lineHashes[lineNo], rootHash: this._rootHash() };
    const contextBefore = this._contextHash(lineNo);
    const hitsRemoved = this.lineHits[lineNo].length;

    this.lines[lineNo] = text;
    this.lineHashes[lineNo] = sha256(text);
    this.lineHits[lineNo] = this._scanLine(lineNo); // incremental: rescan window only

    const after = { lineHash: this.lineHashes[lineNo], rootHash: this._rootHash() };
    const contextAfter = this._contextHash(lineNo);
    return {
      ok: true,
      patched: lineNo,
      window: { start: lineNo, end: lineNo },
      before,
      after,
      contextHash: contextBefore,
      contextIntact: contextBefore === contextAfter,
      hitsRemoved,
      hitsAdded: this.lineHits[lineNo].length,
    };
  }

  scan() {
    const t0 = performance.now();
    const hits = [];
    for (const h of this.lineHits) hits.push(...h);
    const stats = {
      lines: this.lines.length,
      exactRules: this.rules.exact.length,
      regexRules: this.rules.regex.length,
      hits: hits.length,
      acStates: this.ac.stateCount,
      dfaStates: this.dfas.reduce((a, d) => a + d.dfa.stateCount, 0),
      scanMs: Math.round((performance.now() - t0) * 1000) / 1000,
    };
    return { hits, proof: this._proof(hits), stats };
  }

  _proof(hits) {
    return {
      version: 1,
      algo: 'sha256',
      rulesHash: this.rulesHash,
      lineCount: this.lines.length,
      rootHash: this._rootHash(),
      lines: this.lineHashes.map((hash, i) => ({ i, hash })),
      hits,
    };
  }

  // Offline replay verification: re-runs both automata over the current
  // lines and compares hits (incl. state-trajectory digests), per-line
  // hashes, root hash and rules hash against the certificate. Correctness
  // is derived from content hashes and automaton replay only, never from
  // file modification times.
  verify(proof) {
    const fail = (m) => { throw new ScanError('PROOF_MISMATCH', m); };
    if (!proof || typeof proof !== 'object') fail('proof is not an object');
    if (proof.version !== 1 || proof.algo !== 'sha256') fail('unsupported proof version/algo');
    if (proof.rulesHash !== this.rulesHash) fail('rulesHash mismatch');
    if (proof.lineCount !== this.lines.length) fail('lineCount mismatch');
    if (!Array.isArray(proof.lines) || proof.lines.length !== this.lines.length) fail('lines array mismatch');
    for (let i = 0; i < this.lines.length; i++) {
      const e = proof.lines[i];
      if (!e || e.i !== i || e.hash !== this.lineHashes[i]) fail(`line ${i} hash mismatch`);
    }
    if (proof.rootHash !== this._rootHash()) fail('rootHash mismatch');
    const expected = [];
    for (let i = 0; i < this.lines.length; i++) expected.push(...this._scanLine(i)); // replay
    if (!Array.isArray(proof.hits) || JSON.stringify(proof.hits) !== JSON.stringify(expected)) {
      fail('hits/trace mismatch');
    }
    return { ok: true, hits: expected.length };
  }
}

module.exports = { Engine, ScanError, compareHits, MAX_LINES, MAX_EXACT_RULES, FIELDS };
