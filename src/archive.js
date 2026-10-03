import fs from 'node:fs';
import path from 'node:path';
import { canon, eventIdOf } from './canon.js';
import { weightOf, trustOf, TRUST } from './quality.js';

export const CRASH_POINTS = ['preFsync', 'postIndex', 'postManifest'];

function emptyAcc() {
  return { weightedSum: 0, weightSum: 0, nonNull: 0, nullCount: 0, ok: 0, unknown: 0, fail: 0 };
}

function accAdd(acc, value, quality) {
  if (value === null) {
    acc.nullCount += 1;
    return;
  }
  acc.weightedSum += value * weightOf(quality);
  acc.weightSum += weightOf(quality);
  acc.nonNull += 1;
  acc[trustOf(quality)] += 1;
}

function accSub(acc, value, quality) {
  if (value === null) {
    acc.nullCount -= 1;
    return;
  }
  acc.weightedSum -= value * weightOf(quality);
  acc.weightSum -= weightOf(quality);
  acc.nonNull -= 1;
  acc[trustOf(quality)] -= 1;
}

function accMerge(dst, src) {
  dst.weightedSum += src.weightedSum;
  dst.weightSum += src.weightSum;
  dst.nonNull += src.nonNull;
  dst.nullCount += src.nullCount;
  dst.ok += src.ok;
  dst.unknown += src.unknown;
  dst.fail += src.fail;
}

function trustOfAcc(acc) {
  if (acc.fail > 0) return TRUST.fail;
  if (acc.unknown > 0) return TRUST.unknown;
  return TRUST.ok;
}

function finalizeAcc(acc) {
  return {
    weightedMean: acc.weightSum > 0 ? acc.weightedSum / acc.weightSum : null,
    weightSum: acc.weightSum,
    nonNull: acc.nonNull,
    nullCount: acc.nullCount,
    total: acc.nonNull + acc.nullCount,
    trust: trustOfAcc(acc),
  };
}

export class Archive {
  constructor(dir, opts = {}) {
    this.dir = dir;
    this.crashAt = opts.crashAt ?? null;
    this.logPath = path.join(dir, 'events.log');
    this.manifestPath = path.join(dir, 'manifest.json');
    this.tmpManifestPath = path.join(dir, 'manifest.json.tmp');
    this.events = [];
    this.versions = new Map(); // key -> [{eventId, batchId, lamport, value, quality, deleted, flags, undone}]
    this.batches = new Map(); // batchId -> {batchId, lamport, eventIds, undone}
    this.maxLamport = 0;
    this.windowIndex = new Map(); // "site|day" -> acc of effective tips
    this._durableBytes = 0; // bytes of events.log known to be fsynced
    this._load();
  }

  _windowKey(site, validTime) {
    return site + '|' + validTime.slice(0, 10);
  }

  _cell(site, validTime) {
    const wk = this._windowKey(site, validTime);
    if (!this.windowIndex.has(wk)) this.windowIndex.set(wk, emptyAcc());
    return this.windowIndex.get(wk);
  }

  _effectiveTip(key) {
    const versions = this.versions.get(key) ?? [];
    for (let i = versions.length - 1; i >= 0; i--) {
      if (!versions[i].undone) return versions[i];
    }
    return null;
  }

  _applyTipDelta(site, validTime, oldTip, newTip) {
    const cell = this._cell(site, validTime);
    if (oldTip && !oldTip.deleted) accSub(cell, oldTip.value, oldTip.quality);
    if (newTip && !newTip.deleted) accAdd(cell, newTip.value, newTip.quality);
  }

  _load() {
    if (fs.existsSync(this.logPath)) {
      let raw = fs.readFileSync(this.logPath, 'utf8');
      let lines = raw.split('\n').filter((l) => l.length > 0);
      // torn tail: a final line that does not parse is truncated back to the manifest boundary
      if (lines.length > 0) {
        try {
          JSON.parse(lines[lines.length - 1]);
        } catch {
          const committed = this._readManifest()?.committedLamport ?? 0;
          lines = lines.filter((l) => {
            try {
              return JSON.parse(l).lamport <= committed;
            } catch {
              return false;
            }
          });
          raw = lines.length > 0 ? lines.join('\n') + '\n' : '';
          fs.writeFileSync(this.logPath, raw, 'utf8');
        }
      }
      for (const line of lines) {
        const event = JSON.parse(line);
        this.events.push(event);
        this._indexEvent(event);
      }
      this._durableBytes = Buffer.byteLength(raw, 'utf8');
    }
    const manifest = this._readManifest();
    if (manifest) {
      if (manifest.committedLamport > this.maxLamport) {
        // manifest ahead of log: log lost unflushed tail; nothing to do, state matches log
      } else if (this.maxLamport > manifest.committedLamport) {
        // log ahead of manifest: committed-but-uncheckpointed events replayed; refresh checkpoint
        this._writeManifest();
      }
    } else if (this.events.length > 0) {
      this._writeManifest();
    }
  }

  _readManifest() {
    if (!fs.existsSync(this.manifestPath)) return null;
    return JSON.parse(fs.readFileSync(this.manifestPath, 'utf8'));
  }

  _writeManifest() {
    const manifest = { committedLamport: this.maxLamport, eventCount: this.events.length };
    fs.writeFileSync(this.tmpManifestPath, JSON.stringify(manifest), 'utf8');
    const mfd = fs.openSync(this.tmpManifestPath, 'r');
    try {
      fs.fsyncSync(mfd);
    } finally {
      fs.closeSync(mfd);
    }
    fs.renameSync(this.tmpManifestPath, this.manifestPath);
  }

  _indexEvent(event) {
    this.maxLamport = Math.max(this.maxLamport, event.lamport);
    if (event.type === 'batch_open') {
      this.batches.set(event.batchId, {
        batchId: event.batchId,
        lamport: event.lamport,
        eventIds: [],
        undone: false,
      });
      return;
    }
    if (event.type === 'obs') {
      const batch = this.batches.get(event.batchId);
      if (batch) batch.eventIds.push(event.eventId);
      const key = event.site + '|' + event.validTime;
      if (!this.versions.has(key)) this.versions.set(key, []);
      const oldTip = this._effectiveTip(key);
      const version = {
        eventId: event.eventId,
        batchId: event.batchId,
        lamport: event.lamport,
        value: event.value,
        quality: event.quality,
        deleted: event.op === 'delete',
        flags: event.flags ?? [],
        undone: false,
      };
      this.versions.get(key).push(version);
      this._applyTipDelta(event.site, event.validTime, oldTip, version);
      return;
    }
    if (event.type === 'undo') {
      const batch = this.batches.get(event.targetBatchId);
      if (batch) batch.undone = true;
      const touchedKeys = [];
      for (const [key, versions] of this.versions) {
        if (versions.some((v) => v.batchId === event.targetBatchId)) touchedKeys.push(key);
      }
      for (const key of touchedKeys) {
        const versions = this.versions.get(key);
        const oldTip = this._effectiveTip(key);
        for (const v of versions) {
          if (v.batchId === event.targetBatchId) v.undone = true;
        }
        const newTip = this._effectiveTip(key);
        const [site, validTime] = [key.slice(0, key.indexOf('|')), key.slice(key.indexOf('|') + 1)];
        this._applyTipDelta(site, validTime, oldTip, newTip);
      }
    }
  }

  _maybeCrash(point) {
    if (this.crashAt === point) {
      if (point === 'preFsync') {
        // OS buffers lost: bytes appended but never fsynced are gone after the crash
        const fd = fs.openSync(this.logPath, 'r+');
        try {
          fs.ftruncateSync(fd, this._durableBytes);
          fs.fsyncSync(fd);
        } finally {
          fs.closeSync(fd);
        }
      }
      throw Object.assign(new Error(`simulated crash at ${point}`), { crashPoint: point });
    }
  }

  _commit(events) {
    const lines = events.map((e) => JSON.stringify(e) + '\n').join('');
    fs.appendFileSync(this.logPath, lines, 'utf8');
    for (const event of events) {
      this.events.push(event);
      this._indexEvent(event);
    }
    this._maybeCrash('preFsync');
    const fd = fs.openSync(this.logPath, 'r+');
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    this._durableBytes += Buffer.byteLength(lines, 'utf8');
    this._maybeCrash('postIndex');
    this._writeManifest();
    this._maybeCrash('postManifest');
    return events;
  }

  _nextLamport() {
    return this.maxLamport + 1;
  }

  ingest(records) {
    const events = [];
    let lamport = this._nextLamport();
    for (const rec of records) {
      const event = {
        type: 'obs',
        op: 'replace',
        site: rec.site,
        validTime: rec.validTime,
        value: rec.value ?? null,
        quality: rec.quality ?? 'unknown',
        flags: rec.flags ?? [],
        batchId: null,
        lamport: lamport++,
      };
      event.eventId = eventIdOf(event);
      events.push(event);
    }
    this._commit(events);
    return events.map((e) => e.eventId);
  }

  correct(batch) {
    if (!batch.batchId) throw new Error('batch.batchId required');
    if (this.batches.has(batch.batchId)) throw new Error(`duplicate batchId ${batch.batchId}`);
    const events = [];
    let lamport = this._nextLamport();
    const open = { type: 'batch_open', batchId: batch.batchId, lamport: lamport++ };
    open.eventId = eventIdOf(open);
    events.push(open);
    for (const c of batch.corrections ?? []) {
      const event = {
        type: 'obs',
        op: c.op,
        site: c.site,
        validTime: c.validTime,
        value: c.op === 'delete' ? null : c.value ?? null,
        quality: c.quality ?? 'unknown',
        flags: c.flags ?? [],
        batchId: batch.batchId,
        lamport: lamport++,
      };
      event.eventId = eventIdOf(event);
      events.push(event);
    }
    this._commit(events);
    return { batchId: batch.batchId, eventIds: events.map((e) => e.eventId) };
  }

  undo(batchId) {
    const batch = this.batches.get(batchId);
    if (!batch) throw new Error(`unknown batchId ${batchId}`);
    if (batch.undone) throw new Error(`batch ${batchId} already undone`);
    const event = { type: 'undo', targetBatchId: batchId, lamport: this._nextLamport() };
    event.eventId = eventIdOf(event);
    this._commit([event]);
    return event.eventId;
  }

  _effectiveVersions(key) {
    const versions = (this.versions.get(key) ?? []).filter((v) => !v.undone);
    versions.sort((a, b) => a.lamport - b.lamport);
    return versions;
  }

  audit(key) {
    const versions = this.versions.get(key) ?? [];
    const sorted = [...versions].sort((a, b) => a.lamport - b.lamport);
    const chain = sorted.map((v) => ({
      eventId: v.eventId,
      batchId: v.batchId,
      lamport: v.lamport,
      value: v.value,
      quality: v.quality,
      deleted: v.deleted,
      flags: v.flags,
      undone: v.undone,
    }));
    const tip = this._effectiveTip(key);
    const tipState = tip === null ? 'missing' : tip.deleted ? 'deleted' : 'active';
    return {
      key,
      tip: tip === null ? null : { eventId: tip.eventId, batchId: tip.batchId, value: tip.value, quality: tip.quality, flags: tip.flags },
      tipState,
      chain,
    };
  }

  _queryBrute(site, from, to) {
    const acc = emptyAcc();
    const keys = [...this.versions.keys()].filter((k) => k.startsWith(site + '|'));
    for (const key of keys) {
      const validTime = key.slice(site.length + 1);
      if (validTime < from || validTime >= to) continue;
      const tip = this._effectiveTip(key);
      if (tip === null || tip.deleted) continue;
      accAdd(acc, tip.value, tip.quality);
    }
    return acc;
  }

  _queryIndexed(site, from, to) {
    const acc = emptyAcc();
    const fromDay = from.slice(0, 10);
    const toDay = to.slice(0, 10);
    const day = new Date(fromDay + 'T00:00:00Z');
    const endDay = new Date(toDay + 'T00:00:00Z');
    const partialDays = [];
    while (day <= endDay) {
      const dayStr = day.toISOString().slice(0, 10);
      const dayStart = dayStr + 'T00:00:00Z';
      const next = new Date(day.getTime() + 86400000);
      const dayEnd = next.toISOString().slice(0, 10) + 'T00:00:00Z';
      if (dayStart >= from && dayEnd <= to) {
        const cell = this.windowIndex.get(site + '|' + dayStr);
        if (cell) accMerge(acc, cell);
      } else if (dayEnd > from && dayStart < to) {
        partialDays.push([dayStart > from ? dayStart : from, dayEnd < to ? dayEnd : to]);
      }
      day.setTime(day.getTime() + 86400000);
    }
    for (const [lo, hi] of partialDays) {
      accMerge(acc, this._queryBrute(site, lo, hi));
    }
    return acc;
  }

  query(site, from, to, opts = {}) {
    const asOfLamport = opts.asOfLamport ?? null;
    if (asOfLamport !== null) {
      const saved = {
        events: this.events,
        versions: this.versions,
        batches: this.batches,
        windowIndex: this.windowIndex,
        maxLamport: this.maxLamport,
      };
      this.events = saved.events.filter((e) => e.lamport <= asOfLamport);
      this.versions = new Map();
      this.batches = new Map();
      this.windowIndex = new Map();
      this.maxLamport = 0;
      for (const e of this.events) this._indexEvent(e);
      const result = finalizeAcc(this._queryBrute(site, from, to));
      this.events = saved.events;
      this.versions = saved.versions;
      this.batches = saved.batches;
      this.windowIndex = saved.windowIndex;
      this.maxLamport = saved.maxLamport;
      return result;
    }
    const acc = opts.brute ? this._queryBrute(site, from, to) : this._queryIndexed(site, from, to);
    return finalizeAcc(acc);
  }

  certificate(batchId) {
    const batch = this.batches.get(batchId);
    if (!batch) throw new Error(`unknown batchId ${batchId}`);
    const batchEvents = this.events.filter((e) => e.type === 'obs' && e.batchId === batchId);
    const undoEvents = this.events.filter((e) => e.type === 'undo' && e.targetBatchId === batchId);
    const affectedKeys = [...new Set(batchEvents.map((e) => e.site + '|' + e.validTime))].sort();
    const audits = {};
    for (const key of affectedKeys) audits[key] = this.audit(key);
    return {
      batchId,
      batchLamport: batch.lamport,
      undone: batch.undone,
      eventIds: batchEvents.map((e) => e.eventId),
      undoEventIds: undoEvents.map((e) => e.eventId),
      affectedKeys,
      audits,
    };
  }

  static verifyCertificate(cert, archive) {
    const errors = [];
    for (const key of cert.affectedKeys) {
      const live = archive.audit(key);
      const recorded = cert.audits[key];
      if (canon(live) !== canon(recorded)) {
        errors.push(`audit mismatch for ${key}`);
      }
      const batchEvents = live.chain.filter((c) => c.batchId === cert.batchId);
      for (const be of batchEvents) {
        if (be.undone !== cert.undone) {
          errors.push(`key ${key}: batch event ${be.eventId} undone=${be.undone}, expected ${cert.undone}`);
        }
      }
      const others = live.chain.filter((c) => c.batchId !== cert.batchId);
      for (const oe of others) {
        if (oe.undone && !archive.batches.get(oe.batchId)?.undone) {
          errors.push(`key ${key}: foreign event ${oe.eventId} wrongly undone`);
        }
      }
    }
    return { ok: errors.length === 0, errors };
  }
}
