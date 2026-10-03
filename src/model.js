'use strict';

class DomainError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DomainError';
    this.exitCode = 6;
  }
}

class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UsageError';
    this.exitCode = 2;
  }
}

const overlaps = (a, b) => a.start < b.end && b.start < a.end;

function requireInt(value, what) {
  if (!Number.isInteger(value)) throw new UsageError(`${what} must be an integer`);
  return value;
}

function normalizeWindow(raw, stationId, link) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new UsageError(`station ${stationId}: window must be an object`);
  }
  if (typeof raw.id !== 'string' || raw.id.length === 0) {
    throw new UsageError(`station ${stationId}: window requires a non-empty string id`);
  }
  const start = requireInt(raw.start, `window ${raw.id} start`);
  const end = requireInt(raw.end, `window ${raw.id} end`);
  const energy = requireInt(raw.energy, `window ${raw.id} energy`);
  if (end <= start) throw new UsageError(`window ${raw.id}: end must be greater than start`);
  if (energy < 0) {
    throw new DomainError(`negative battery: window ${raw.id} has energy ${energy}`);
  }
  return { id: raw.id, station: stationId, link, start, end, energy, locked: raw.locked === true };
}

function validateLocked(model) {
  const byLink = new Map();
  const lockedEnergy = new Map();
  for (const st of model.stations.values()) {
    for (const w of st.windows) {
      if (!w.locked) continue;
      if (!byLink.has(st.link)) byLink.set(st.link, []);
      byLink.get(st.link).push(w);
      lockedEnergy.set(st.id, (lockedEnergy.get(st.id) || 0) + w.energy);
    }
  }
  for (const [link, wins] of byLink) {
    const sorted = wins.slice().sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
    for (let i = 1; i < sorted.length; i++) {
      if (overlaps(sorted[i - 1], sorted[i])) {
        throw new DomainError(
          `mutex overlap on link ${link}: locked windows ${sorted[i - 1].id} and ${sorted[i].id}`
        );
      }
    }
  }
  for (const [stId, energy] of lockedEnergy) {
    const st = model.stations.get(stId);
    if (energy > st.battery) {
      throw new DomainError(
        `negative battery: locked windows of station ${stId} need ${energy} but battery is ${st.battery}`
      );
    }
  }
}

function normalizeScenario(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new UsageError('scenario must be an object');
  }
  if (!Array.isArray(raw.stations) || raw.stations.length === 0) {
    throw new UsageError('scenario requires a non-empty stations array');
  }
  const floor = raw.floor === undefined ? 1 : requireInt(raw.floor, 'floor');
  if (floor < 0) throw new UsageError('floor must be >= 0');
  const stations = new Map();
  for (const rawSt of raw.stations) {
    if (rawSt === null || typeof rawSt !== 'object') throw new UsageError('station must be an object');
    if (typeof rawSt.id !== 'string' || rawSt.id.length === 0) {
      throw new UsageError('station requires a non-empty string id');
    }
    if (stations.has(rawSt.id)) throw new UsageError(`duplicate station ${rawSt.id}`);
    const link = rawSt.link === undefined ? `solo:${rawSt.id}` : rawSt.link;
    if (typeof link !== 'string' || link.length === 0) {
      throw new UsageError(`station ${rawSt.id}: link must be a non-empty string`);
    }
    const battery = requireInt(rawSt.battery, `station ${rawSt.id} battery`);
    if (battery < 0) {
      throw new DomainError(`negative battery: station ${rawSt.id} has battery ${battery}`);
    }
    const windows = (rawSt.windows || []).map((w) => normalizeWindow(w, rawSt.id, link));
    const ids = new Set();
    for (const w of windows) {
      if (ids.has(w.id)) throw new UsageError(`duplicate window id ${w.id} on station ${rawSt.id}`);
      ids.add(w.id);
    }
    stations.set(rawSt.id, { id: rawSt.id, link, battery, windows });
  }
  const contracts = (raw.contracts || []).map((c, i) => {
    if (c === null || typeof c !== 'object') throw new UsageError(`contract #${i} must be an object`);
    if (typeof c.id !== 'string' || c.id.length === 0) {
      throw new UsageError(`contract #${i} requires a non-empty string id`);
    }
    if (!stations.has(c.station)) throw new UsageError(`contract ${c.id}: unknown station ${c.station}`);
    const min = requireInt(c.min, `contract ${c.id} min`);
    if (min < 1) throw new UsageError(`contract ${c.id}: min must be >= 1`);
    let period = null;
    let quota = null;
    if (c.period !== undefined || c.quota !== undefined) {
      period = requireInt(c.period, `contract ${c.id} period`);
      quota = requireInt(c.quota, `contract ${c.id} quota`);
      if (period < 1 || quota < 1) {
        throw new UsageError(`contract ${c.id}: period and quota must be >= 1`);
      }
    }
    return { id: c.id, station: c.station, min, period, quota };
  });
  const model = {
    name: typeof raw.name === 'string' ? raw.name : 'unnamed',
    floor,
    stations,
    contracts,
    faults: [],
  };
  validateLocked(model);
  return model;
}

function isFaultBlocked(model, stationId, w) {
  for (const f of model.faults) {
    if (f.resolved || f.station !== stationId) continue;
    if (overlaps(f, w)) return true;
  }
  return false;
}

module.exports = {
  DomainError,
  UsageError,
  overlaps,
  normalizeScenario,
  normalizeWindow,
  validateLocked,
  isFaultBlocked,
};
