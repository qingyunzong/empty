'use strict';

const { MergeError, ZoneTable, parseUtcInstant } = require('./timezone');
const { computeMerged } = require('./merge');

const STATES = new Set(['ON', 'OFF']);

function iso(ms) {
  return new Date(ms).toISOString();
}

class Engine {
  constructor() {
    this.zoneTable = new ZoneTable();
    this.periods = null; // { startMs, durationMs, endMs }
    this.silences = []; // [{ startMs, endMs }] sorted by startMs
    this.records = new Map(); // event id -> [{ version, rec }] ascending by version; rec null = voided
    this.seq = 0;
    this.lastMerge = new Map(); // `${deviceId}|${upToVersion ?? 'latest'}` -> intervals snapshot
  }

  execute(cmd) {
    if (cmd === null || typeof cmd !== 'object' || typeof cmd.cmd !== 'string') {
      throw new MergeError('INVALID_COMMAND', 'command must be an object with a "cmd" string');
    }
    switch (cmd.cmd) {
      case 'defineZone': return this.#defineZone(cmd);
      case 'definePeriods': return this.#definePeriods(cmd);
      case 'defineSilence': return this.#defineSilence(cmd);
      case 'event': return this.#addEvent(cmd);
      case 'replace': return this.#replace(cmd);
      case 'void': return this.#void(cmd);
      case 'merge': return this.#merge(cmd);
      default: throw new MergeError('UNKNOWN_COMMAND', `unknown command: ${cmd.cmd}`);
    }
  }

  // Like execute, but converts errors into JSON-line friendly objects.
  safeExecute(cmd) {
    try {
      return this.execute(cmd);
    } catch (err) {
      if (err instanceof MergeError) {
        return { type: 'error', code: err.code, message: err.message };
      }
      return { type: 'error', code: 'INTERNAL', message: String(err && err.message || err) };
    }
  }

  #defineZone(cmd) {
    const r = this.zoneTable.define(cmd.zone, cmd.offsets);
    return { type: 'ok', command: 'defineZone', zone: r.zone, segments: r.segments };
  }

  #definePeriods(cmd) {
    const startMs = parseUtcInstant(cmd.startUtc !== undefined ? cmd.startUtc : cmd.startUtcMs, 'startUtc');
    const endMs = parseUtcInstant(cmd.endUtc !== undefined ? cmd.endUtc : cmd.endUtcMs, 'endUtc');
    const durationMs = cmd.durationMs;
    if (!Number.isInteger(durationMs) || durationMs <= 0) {
      throw new MergeError('PERIOD_INVERTED', `durationMs must be a positive integer, got ${durationMs}`);
    }
    if (endMs <= startMs) {
      throw new MergeError('PERIOD_INVERTED', `period end (${iso(endMs)}) must be after start (${iso(startMs)})`);
    }
    this.periods = { startMs, durationMs, endMs };
    return { type: 'ok', command: 'definePeriods', startUtc: iso(startMs), durationMs, endUtc: iso(endMs) };
  }

  #defineSilence(cmd) {
    const startMs = parseUtcInstant(cmd.startUtc !== undefined ? cmd.startUtc : cmd.startUtcMs, 'startUtc');
    const endMs = parseUtcInstant(cmd.endUtc !== undefined ? cmd.endUtc : cmd.endUtcMs, 'endUtc');
    if (endMs <= startMs) {
      throw new MergeError('INVALID_SILENCE', `silence end (${iso(endMs)}) must be after start (${iso(startMs)})`);
    }
    this.silences.push({ startMs, endMs });
    this.silences.sort((a, b) => a.startMs - b.startMs);
    return { type: 'ok', command: 'defineSilence', startUtc: iso(startMs), endUtc: iso(endMs) };
  }

  #normalizeState(state) {
    const s = typeof state === 'string' ? state.toUpperCase() : state;
    if (!STATES.has(s)) {
      throw new MergeError('INVALID_STATE', `state must be ON or OFF, got ${state}`);
    }
    return s;
  }

  #buildRec(id, raw, version) {
    if (raw === null || typeof raw !== 'object') {
      throw new MergeError('INVALID_EVENT', 'event must be an object');
    }
    if (typeof raw.deviceId !== 'string' || raw.deviceId.length === 0) {
      throw new MergeError('INVALID_EVENT', 'event.deviceId must be a non-empty string');
    }
    const state = this.#normalizeState(raw.state);
    const utcMs = this.zoneTable.toUtc(raw.zone, raw.localTime); // UNKNOWN_ZONE / LOCAL_TIME_INVALID
    return {
      id,
      deviceId: raw.deviceId,
      state,
      utcMs,
      zone: raw.zone,
      localTime: raw.localTime,
      version,
      seq: this.seq++,
    };
  }

  #addEvent(cmd) {
    const raw = cmd.event;
    if (raw === null || typeof raw !== 'object' || typeof raw.id !== 'string' || raw.id.length === 0) {
      throw new MergeError('INVALID_EVENT', 'event.id must be a non-empty string');
    }
    if (this.records.has(raw.id)) {
      throw new MergeError('DUPLICATE_ID', `event id already exists (use replace/void): ${raw.id}`);
    }
    const version = raw.version !== undefined ? raw.version : 1;
    if (!Number.isInteger(version) || version < 1) {
      throw new MergeError('VERSION_CONFLICT', `version must be a positive integer, got ${version}`);
    }
    const rec = this.#buildRec(raw.id, raw, version);
    this.records.set(raw.id, [{ version, rec }]);
    return { type: 'ok', command: 'event', id: raw.id, version, utcMs: rec.utcMs, utc: iso(rec.utcMs) };
  }

  #latestVersion(id) {
    const versions = this.records.get(id);
    if (!versions) return null;
    return versions[versions.length - 1].version;
  }

  #replace(cmd) {
    const id = cmd.id;
    const versions = this.records.get(id);
    if (!versions) {
      throw new MergeError('UNKNOWN_EVENT', `cannot replace unknown event id: ${id}`);
    }
    const maxV = this.#latestVersion(id);
    const version = (cmd.event && cmd.event.version !== undefined) ? cmd.event.version : maxV + 1;
    if (!Number.isInteger(version) || version <= maxV) {
      throw new MergeError('VERSION_CONFLICT', `replace version must be > ${maxV}, got ${version}`);
    }
    const rec = this.#buildRec(id, { ...cmd.event, id }, version);
    versions.push({ version, rec });
    return { type: 'ok', command: 'replace', id, version, utcMs: rec.utcMs, utc: iso(rec.utcMs) };
  }

  #void(cmd) {
    const id = cmd.id;
    const versions = this.records.get(id);
    if (!versions) {
      throw new MergeError('UNKNOWN_EVENT', `cannot void unknown event id: ${id}`);
    }
    const maxV = this.#latestVersion(id);
    const version = cmd.version !== undefined ? cmd.version : maxV + 1;
    if (!Number.isInteger(version) || version <= maxV) {
      throw new MergeError('VERSION_CONFLICT', `void version must be > ${maxV}, got ${version}`);
    }
    versions.push({ version, rec: null });
    return { type: 'ok', command: 'void', id, version };
  }

  // Effective events for a device at a replay version: for each event id take
  // the record with the highest version <= upToVersion (a void tombstone
  // removes the event). Sorted by (utcMs, version, seq).
  effectiveEvents(deviceId, upToVersion) {
    const out = [];
    for (const versions of this.records.values()) {
      let chosen = null;
      for (const v of versions) {
        if (upToVersion === undefined || upToVersion === null || v.version <= upToVersion) {
          chosen = v;
        } else {
          break;
        }
      }
      if (chosen && chosen.rec && chosen.rec.deviceId === deviceId) {
        out.push(chosen.rec);
      }
    }
    out.sort((a, b) => a.utcMs - b.utcMs || a.version - b.version || a.seq - b.seq);
    return out;
  }

  #merge(cmd) {
    if (typeof cmd.deviceId !== 'string' || cmd.deviceId.length === 0) {
      throw new MergeError('INVALID_COMMAND', 'merge.deviceId must be a non-empty string');
    }
    const obs = cmd.observation;
    if (obs === null || typeof obs !== 'object') {
      throw new MergeError('INVALID_OBSERVATION', 'merge.observation is required');
    }
    const obsStart = parseUtcInstant(obs.startUtc !== undefined ? obs.startUtc : obs.startUtcMs, 'observation.startUtc');
    const cutoff = parseUtcInstant(obs.cutoffUtc !== undefined ? obs.cutoffUtc : obs.cutoffUtcMs, 'observation.cutoffUtc');
    if (cutoff <= obsStart) {
      throw new MergeError('INVALID_OBSERVATION', `observation cutoff (${iso(cutoff)}) must be after start (${iso(obsStart)})`);
    }
    const upToVersion = cmd.upToVersion !== undefined ? cmd.upToVersion : null;
    if (upToVersion !== null && (!Number.isInteger(upToVersion) || upToVersion < 1)) {
      throw new MergeError('VERSION_CONFLICT', `upToVersion must be a positive integer, got ${upToVersion}`);
    }

    const events = this.effectiveEvents(cmd.deviceId, upToVersion === null ? undefined : upToVersion);
    const raw = computeMerged({
      events,
      periods: this.periods,
      silences: this.silences,
      obsStart,
      cutoff,
    });

    // Enrich intervals: index, UNCLOSED flag, ISO bounds, merged event ids.
    const intervals = raw.map((iv, index) => ({
      index,
      deviceId: cmd.deviceId,
      state: iv.state,
      scope: iv.scope,
      startUtcMs: iv.startUtcMs,
      endUtcMs: iv.endUtcMs,
      startUtc: iso(iv.startUtcMs),
      endUtc: iso(iv.endUtcMs),
      unclosed: iv.endUtcMs === cutoff,
      eventIds: [],
    }));

    // Assign each effective event to the interval containing its instant;
    // events outside the observation window are reported separately.
    const outsideObservation = [];
    const timelineOf = intervals.map(() => []);
    for (const e of events) {
      const entry = { id: e.id, utcMs: e.utcMs, utc: iso(e.utcMs), state: e.state, version: e.version };
      if (e.utcMs >= obsStart && e.utcMs < cutoff) {
        const iv = intervals.find((i) => e.utcMs >= i.startUtcMs && e.utcMs < i.endUtcMs);
        if (iv) {
          iv.eventIds.push(e.id);
          timelineOf[iv.index].push(entry);
        } else {
          outsideObservation.push(entry);
        }
      } else {
        outsideObservation.push(entry);
      }
    }
    for (const iv of intervals) {
      iv.mergedCount = iv.eventIds.length;
    }

    // Diff against the previous merge for the same device+version to derive
    // the affected range caused by corrections since then.
    const cacheKey = `${cmd.deviceId}|${upToVersion === null ? 'latest' : upToVersion}`;
    const previous = this.lastMerge.get(cacheKey);
    const snapshot = intervals.map((iv) => ({
      state: iv.state, scope: iv.scope, startUtcMs: iv.startUtcMs,
      endUtcMs: iv.endUtcMs, unclosed: iv.unclosed, eventIds: iv.eventIds,
    }));
    let changedIntervalIndexes = [];
    let affectedRange = null;
    if (previous) {
      const maxLen = Math.max(previous.length, snapshot.length);
      for (let i = 0; i < maxLen; i++) {
        if (JSON.stringify(previous[i]) !== JSON.stringify(snapshot[i])) {
          changedIntervalIndexes.push(i);
        }
      }
      if (changedIntervalIndexes.length > 0) {
        const changed = changedIntervalIndexes
          .filter((i) => i < intervals.length)
          .map((i) => intervals[i]);
        const removed = previous.slice(snapshot.length);
        const from = Math.min(
          ...changed.map((iv) => iv.startUtcMs),
          ...removed.map((iv) => iv.startUtcMs),
        );
        const to = Math.max(
          ...changed.map((iv) => iv.endUtcMs),
          ...removed.map((iv) => iv.endUtcMs),
        );
        affectedRange = { fromUtcMs: from, toUtcMs: to, fromUtc: iso(from), toUtc: iso(to) };
      }
    } else {
      changedIntervalIndexes = intervals.map((iv) => iv.index);
    }
    this.lastMerge.set(cacheKey, snapshot);

    const certificate = {
      deviceId: cmd.deviceId,
      upToVersion,
      eventCount: events.length,
      intervals: intervals.map((iv, i) => ({
        index: iv.index,
        state: iv.state,
        scope: iv.scope,
        startUtcMs: iv.startUtcMs,
        endUtcMs: iv.endUtcMs,
        unclosed: iv.unclosed,
        mergedEventIds: iv.eventIds,
        timeline: timelineOf[i],
      })),
      outsideObservation,
      changedIntervalIndexes,
      affectedRange,
    };

    return {
      type: 'mergeResult',
      deviceId: cmd.deviceId,
      upToVersion,
      observation: { startUtcMs: obsStart, cutoffUtcMs: cutoff, startUtc: iso(obsStart), cutoffUtc: iso(cutoff) },
      intervals,
      affectedRange,
      certificate,
    };
  }
}

module.exports = { Engine, MergeError };
