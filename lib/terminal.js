'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { AuditLog, entryHash } = require('./log');
const { sha256hex, canonical } = require('./util');
const { encodeFrame } = require('./frame');

// The terminal's virtual clock is the number of committed log entries: it is
// deterministic, survives crashes (it is derived from the log itself), and a
// frame's lease is valid iff its commit clock would be <= leaseUntil.
class Terminal {
  constructor(dir, opts = {}) {
    this.dir = dir || null;
    this.hooks = opts.hooks || {};
    this.log = new AuditLog(this.dir, opts);
    this.log.open();
    this.evidencePath = this.dir ? path.join(this.dir, 'evidence.log') : null;
    this.indexPath = this.dir ? path.join(this.dir, 'audit.index.json') : null;
    this.state = new Map();
    this.byOpId = new Map();
    this.rejected = new Map();
    this.expectedSeq = new Map();
    this.pending = [];
    this.evidence = [];
    this.leaseExpired = 0;
    this._loadEvidence();
    this._restoreIndex();
  }

  submit(frame, raw) {
    if (!raw) raw = encodeFrame(frame);
    const events = [];
    const dup = this.byOpId.get(frame.opId);
    if (dup) {
      events.push({ opId: frame.opId, actor: frame.actor, status: 'duplicate', index: dup.index, hash: dup.hash });
      return events;
    }
    if (this.rejected.has(frame.opId)) {
      events.push({ opId: frame.opId, actor: frame.actor, status: 'rejected', reason: this.rejected.get(frame.opId), duplicate: true });
      return events;
    }
    const expected = this.expectedSeq.get(frame.actor) || 1;
    if (frame.seq < expected) {
      this._reject(frame, 'stale_seq', events, raw);
      return events;
    }
    this.pending.push({ frame, raw });
    if (!this._eligible(frame)) {
      events.push({ opId: frame.opId, actor: frame.actor, status: 'buffered' });
    }
    this._drain(events);
    return events;
  }

  _eligible(frame) {
    return frame.prevHash === this.log.headHash && frame.seq === (this.expectedSeq.get(frame.actor) || 1);
  }

  _drain(events) {
    let progress = true;
    while (progress) {
      progress = false;
      for (let i = 0; i < this.pending.length; i++) {
        const { frame, raw } = this.pending[i];
        if (!this._eligible(frame)) continue;
        this.pending.splice(i, 1);
        const clock = this.log.entries.length;
        if (frame.leaseUntil < clock) {
          this._reject(frame, 'lease_expired', events, raw);
          this.expectedSeq.set(frame.actor, frame.seq + 1);
        } else {
          const built = this._buildEntry(frame);
          if (built.error) {
            this._reject(frame, built.error, events, raw);
            this.expectedSeq.set(frame.actor, frame.seq + 1);
          } else {
            this._apply(frame, built, events);
          }
        }
        progress = true;
        break;
      }
    }
  }

  _apply(frame, built, events) {
    const { entry, effect } = built;
    this.log.append(entry); // crash point 2 (after flush) fires inside
    this._commitEffect(effect);
    this.byOpId.set(entry.opId, entry);
    this.expectedSeq.set(frame.actor, frame.seq + 1);
    this._persistIndex();
    if (this.hooks.afterIndex) this.hooks.afterIndex(entry); // crash point 3
    this.log.maybeCheckpoint();
    events.push({
      opId: frame.opId, actor: frame.actor, status: 'applied',
      index: entry.index, hash: entry.hash, cmd: entry.cmd, result: entry.result,
    });
  }

  _reject(frame, reason, events, raw) {
    const ev = {
      opId: frame.opId, actor: frame.actor, seq: frame.seq, reason,
      leaseUntil: frame.leaseUntil, clock: this.log.entries.length,
      frameHash: sha256hex(raw),
    };
    this.evidence.push(ev);
    if (this.evidencePath) fs.appendFileSync(this.evidencePath, JSON.stringify(ev) + '\n');
    this.rejected.set(frame.opId, reason);
    if (reason === 'lease_expired') this.leaseExpired++;
    events.push({ opId: frame.opId, actor: frame.actor, status: 'rejected', reason });
  }

  _buildEntry(frame) {
    const index = this.log.entries.length;
    const base = {
      index, vclock: index, kind: 'exec',
      opId: frame.opId, actor: frame.actor, seq: frame.seq, ack: frame.ack,
      leaseUntil: frame.leaseUntil, cmd: frame.cmd, args: frame.args,
      prevHash: this.log.headHash,
    };
    const stateHashBefore = this._stateHash();
    let effect = null;
    let extra = {};
    let result = { ok: true };
    const args = frame.args || {};
    switch (frame.cmd) {
      case 'set': {
        if (typeof args.key !== 'string' || args.key.length === 0 || !('value' in args)) return { error: 'bad_args' };
        extra = { key: args.key, prevValue: this._get(args.key), newValue: args.value };
        effect = { key: args.key, value: args.value };
        break;
      }
      case 'del': {
        if (typeof args.key !== 'string' || args.key.length === 0) return { error: 'bad_args' };
        extra = { key: args.key, prevValue: this._get(args.key), newValue: null };
        effect = { key: args.key, value: null };
        break;
      }
      case 'noop':
        break;
      case 'undo': {
        const target = typeof args.opId === 'string' ? this.byOpId.get(args.opId) : undefined;
        if (!target) return { error: 'undo_target_unknown' };
        if (target.key === undefined || target.key === null) return { error: 'undo_target_not_stateful' };
        extra = {
          kind: 'inverse',
          undoOf: target.opId,
          proof: { targetHash: target.hash, targetIndex: target.index, targetStateBefore: target.stateHashBefore },
          key: target.key,
          prevValue: this._get(target.key),
          newValue: target.prevValue,
        };
        effect = { key: target.key, value: target.prevValue };
        result = { ok: true, undoOf: target.opId };
        break;
      }
      default:
        return { error: 'unknown_cmd' };
    }
    const entry = { ...base, ...extra, stateHashBefore, stateHashAfter: this._stateHash(effect), result };
    entry.hash = entryHash(entry);
    return { entry, effect };
  }

  _get(key) {
    return this.state.has(key) ? this.state.get(key) : null;
  }

  _commitEffect(effect) {
    if (!effect) return;
    if (effect.value === null) this.state.delete(effect.key);
    else this.state.set(effect.key, effect.value);
  }

  _stateHash(extraEffect) {
    const entries = [...this.state.entries()];
    if (extraEffect) {
      const i = entries.findIndex(([k]) => k === extraEffect.key);
      if (extraEffect.value === null) {
        if (i !== -1) entries.splice(i, 1);
      } else if (i === -1) entries.push([extraEffect.key, extraEffect.value]);
      else entries[i] = [extraEffect.key, extraEffect.value];
    }
    entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    return sha256hex(canonical(entries));
  }

  _loadEvidence() {
    if (!this.evidencePath || !fs.existsSync(this.evidencePath)) return;
    for (const line of fs.readFileSync(this.evidencePath, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        this.evidence.push(JSON.parse(line));
      } catch {
        break; // torn tail of the evidence log
      }
    }
  }

  _restoreIndex() {
    for (const e of this.log.entries) {
      if (e.key !== undefined && e.key !== null) this._commitEffect({ key: e.key, value: e.newValue });
      this.byOpId.set(e.opId, e);
      this.expectedSeq.set(e.actor, e.seq + 1);
    }
    let trusted = false;
    if (this.indexPath && fs.existsSync(this.indexPath)) {
      try {
        const idx = JSON.parse(fs.readFileSync(this.indexPath, 'utf8'));
        if (idx.count === this.log.entries.length && idx.headHash === this.log.headHash) {
          this.state = new Map(idx.state);
          this.expectedSeq = new Map(idx.expectedSeq);
          this.rejected = new Map(idx.rejected);
          trusted = true;
        }
      } catch {
        // fall through to rebuild
      }
    }
    // Evidence is authoritative for rejections (it may be newer than the index).
    for (const ev of this.evidence) {
      this.rejected.set(ev.opId, ev.reason);
      const cur = this.expectedSeq.get(ev.actor) || 1;
      if (ev.seq >= cur) this.expectedSeq.set(ev.actor, ev.seq + 1);
    }
    if (!trusted) this._persistIndex();
  }

  _persistIndex() {
    if (!this.indexPath) return;
    const idx = {
      count: this.log.entries.length,
      headHash: this.log.headHash,
      state: [...this.state.entries()],
      expectedSeq: [...this.expectedSeq.entries()],
      rejected: [...this.rejected.entries()],
    };
    fs.writeFileSync(this.indexPath, JSON.stringify(idx));
  }
}

module.exports = { Terminal };
