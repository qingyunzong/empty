'use strict';

const fs = require('fs');
const path = require('path');
const { ScanError, buildAutomata, scanLine, hitTrajectory } = require('./scanner');
const { sha256hex, hashObj, buildProof } = require('./proof');

const MAX_LINES = 100000;
const REQUIRED_FIELDS = ['lineNo', 'counterparty', 'currency', 'amount', 'memo'];

function splitLines(text) {
  const trailing = text.endsWith('\n');
  const lines = text.split('\n');
  if (trailing) lines.pop();
  return { lines, trailing };
}

class Session {
  constructor() {
    this.loaded = false;
  }

  load(filePath, rulesPath) {
    const rulesRaw = fs.readFileSync(rulesPath);
    const rulesJson = JSON.parse(rulesRaw.toString('utf8'));
    const rules = Array.isArray(rulesJson) ? rulesJson : rulesJson.rules;
    const automata = buildAutomata(rules); // throws DUP_RULE / OFFSET_OVERFLOW / BAD_RULE

    const buf = fs.readFileSync(filePath);
    const text = buf.toString('utf8');
    const { lines, trailing } = splitLines(text);
    if (lines.length > MAX_LINES) {
      throw new ScanError('OFFSET_OVERFLOW', `line count ${lines.length} exceeds ${MAX_LINES}`);
    }

    this.filePath = filePath;
    this.rulesPath = rulesPath;
    this.rules = rules;
    this.rulesHash = sha256hex(rulesRaw);
    this.automata = automata;
    this.lines = lines;
    this.trailingNewline = trailing;
    this.fileHash = sha256hex(buf);
    this.lineHits = lines.map((l) => scanLine(l, automata));
    this.loaded = true;
    return { stats: this.stats() };
  }

  stats() {
    let hits = 0;
    for (const h of this.lineHits) hits += h.length;
    let dfaStates = 0;
    for (const d of this.automata.dfas.values()) dfaStates += d.stateCount;
    return {
      lines: this.lines.length,
      exactRules: this.rules.filter((r) => r.type === 'exact').length,
      regexRules: this.rules.filter((r) => r.type === 'regex').length,
      hits,
      acStates: this.automata.ac.stateCount(),
      dfaStates,
    };
  }

  // Flat ordered hit list: line asc, then (start, length, ruleId).
  allHits() {
    const out = [];
    for (let i = 0; i < this.lines.length; i++) {
      for (const h of this.lineHits[i]) {
        out.push({
          line: i + 1,
          start: h.start,
          end: h.end,
          length: h.end - h.start,
          ruleId: h.ruleId,
          kind: h.kind,
          match: this.lines[i].slice(h.start, h.end),
        });
      }
    }
    return out;
  }

  trajectoriesFor(hits) {
    return hits.map((h) => hitTrajectory(h, this.lines[h.line - 1], this.automata));
  }

  scan() {
    this.requireLoaded();
    const started = Date.now();
    const hits = this.allHits();
    const trajectories = this.trajectoriesFor(hits);
    const stats = { ...this.stats(), scanMs: Date.now() - started };
    const proof = buildProof({
      rulesHash: this.rulesHash,
      fileHash: this.fileHash,
      lineCount: this.lines.length,
      hitEntries: hits,
      trajectories,
      stats,
    });
    return { hits, proof, stats };
  }

  // Replace one line (1-based). Only the affected window [line, line] is
  // rescanned; per-line scanning makes that window exact by construction.
  patch(lineNo, record) {
    this.requireLoaded();
    if (!Number.isInteger(lineNo) || lineNo < 1 || lineNo > this.lines.length) {
      throw new ScanError('BAD_PATCH', `line ${lineNo} out of range 1..${this.lines.length}`);
    }
    if (lineNo > MAX_LINES) {
      throw new ScanError('OFFSET_OVERFLOW', `line ${lineNo} exceeds ${MAX_LINES}`);
    }
    if (record === null || typeof record !== 'object' || Array.isArray(record)) {
      throw new ScanError('BAD_PATCH', 'record must be a JSON object');
    }
    for (const f of REQUIRED_FIELDS) {
      if (!(f in record)) throw new ScanError('BAD_PATCH', `record missing field: ${f}`);
    }
    const newLine = JSON.stringify(record);

    const idx = lineNo - 1;
    const before = {
      lineHash: sha256hex(this.lines[idx]),
      hits: this.lineHits[idx].length,
    };
    const fileHashBefore = this.fileHash;

    // Incremental rescan of the affected window only.
    this.lines[idx] = newLine;
    this.lineHits[idx] = scanLine(newLine, this.automata);

    const newText = this.lines.join('\n') + (this.trailingNewline ? '\n' : '');
    const tmp = this.filePath + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, newText);
    fs.renameSync(tmp, this.filePath); // atomic replace, only after validation
    this.fileHash = sha256hex(newText);

    const after = {
      lineHash: sha256hex(newLine),
      hits: this.lineHits[idx].length,
    };
    const proof = {
      kind: 'incremental-patch',
      algo: 'sha256',
      window: [lineNo, lineNo],
      before,
      after,
      fileHashBefore,
      fileHashAfter: this.fileHash,
      note: 'per-line scanning: affected window is exactly the replaced line',
    };
    return { window: [lineNo, lineNo], proof, hits: this.allHits(), stats: this.stats() };
  }

  // Offline replay: recompute hashes, hits and trajectories from the current
  // file and rules, and require exact equality with the certificate.
  verify(proof) {
    this.requireLoaded();
    if (!proof || typeof proof !== 'object') {
      throw new ScanError('PROOF_MISMATCH', 'missing proof');
    }
    const fail = (why) => { throw new ScanError('PROOF_MISMATCH', why); };

    const freshRules = fs.readFileSync(this.rulesPath);
    if (sha256hex(freshRules) !== proof.rulesHash) fail('rulesHash mismatch');
    const freshFile = fs.readFileSync(this.filePath);
    if (sha256hex(freshFile) !== proof.fileHash) fail('fileHash mismatch');
    if (proof.lineCount !== this.lines.length) fail('lineCount mismatch');

    const hits = this.allHits();
    if (hashObj(hits) !== proof.hitsHash) fail('hitsHash mismatch');

    const trajectories = this.trajectoriesFor(hits);
    const recomputed = hits.map((h, i) => ({
      i,
      line: h.line,
      start: h.start,
      end: h.end,
      ruleId: h.ruleId,
      kind: h.kind,
      states: hashObj(trajectories[i]),
    }));
    if (hashObj(recomputed) !== proof.trajHash) fail('trajHash mismatch');
    if (!Array.isArray(proof.trajectory) || hashObj(proof.trajectory) !== proof.trajHash) {
      fail('trajectory entries inconsistent with trajHash');
    }
    if (hashObj(recomputed) !== hashObj(proof.trajectory)) fail('trajectory replay mismatch');

    return { verified: true, hits: hits.length, stats: this.stats() };
  }

  requireLoaded() {
    if (!this.loaded) throw new ScanError('BAD_PATCH', 'no file loaded');
  }
}

module.exports = { Session, MAX_LINES, REQUIRED_FIELDS };
