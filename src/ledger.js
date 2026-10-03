import { existsSync, readFileSync } from 'node:fs';
import { LineageError, E_TIME, E_INPUT } from './errors.js';
import { buildState, walk, searchMask } from './state.js';
import { verifyProof } from './certs.js';

// Append-only event ledger. Events carry a non-decreasing ts; out-of-order
// timestamps are rejected with E_TIME. The full history is kept so any time
// slice can be reconstructed by replay.
export class Ledger {
  constructor(events = []) {
    this.events = events;
    this._state = null;
  }

  static load(path) {
    const ledger = new Ledger();
    if (!existsSync(path)) return ledger;
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (line.trim()) ledger.append(JSON.parse(line));
    }
    return ledger;
  }

  get lastTs() {
    return this.events.length ? this.events.at(-1).ts : -Infinity;
  }

  append(ev) {
    if (typeof ev.ts !== 'number' || !Number.isFinite(ev.ts)) {
      throw new LineageError(E_INPUT, 'event requires a numeric ts');
    }
    if (ev.ts < this.lastTs) {
      throw new LineageError(
        E_TIME,
        `out-of-order event: ts ${ev.ts} before last ts ${this.lastTs}`,
      );
    }
    buildState(this.events.concat([ev])); // validates E_CYCLE / E_INPUT
    this.events.push(ev);
    this._state = null;
    return ev;
  }

  stateAt(at = Infinity) {
    if (at === Infinity) return (this._state ??= buildState(this.events));
    return buildState(this.events, at);
  }

  ancestors(id, at = Infinity) {
    return walk(this.stateAt(at), id, 'parents');
  }

  descendants(id, at = Infinity) {
    return walk(this.stateAt(at), id, 'children');
  }

  searchPhrase(query, at = Infinity) {
    const s = this.stateAt(at);
    return searchMask(s, s.index.phrase(query));
  }

  searchNear(a, b, k = 3, at = Infinity) {
    const s = this.stateAt(at);
    return searchMask(s, s.index.near(a, b, k));
  }

  cert(id, at = Infinity) {
    const versions = this.stateAt(at).certs.get(id);
    if (!versions) throw new LineageError(E_INPUT, `unknown batch ${id}`);
    return versions.at(-1);
  }

  prove(id, version = null) {
    const s = this.stateAt();
    const versions = s.certs.get(id);
    if (!versions) throw new LineageError(E_INPUT, `unknown batch ${id}`);
    const cert = version == null ? versions.at(-1) : versions[version];
    if (!cert) throw new LineageError(E_INPUT, `no cert version ${version} for ${id}`);
    return { ...s.certLog.prove(s.certIndex.get(cert.hash)), cert };
  }

  root() {
    return this.stateAt().certLog.root;
  }

  static verifyProof = verifyProof;
}
