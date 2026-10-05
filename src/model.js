'use strict';

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
  }
}

function fail(message) {
  throw new ValidationError(message);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

// Validates the raw parsed JSON and returns a normalized model:
// {
//   feeders: [{ id, capacity, loadIds }],
//   loads: [{ id, power, level, maxStage, fixedStage, feederId, shedPerStage }],
//   loadIndex: Map<id, index>,
//   interlocks: [{ type: 'together', loads: [id...] }
//                | { type: 'order', first, then }
//                | { type: 'noshed', load }]
// }
function validateModel(raw) {
  if (!isPlainObject(raw)) fail('model must be a JSON object');
  if (!Array.isArray(raw.feeders) || raw.feeders.length === 0) {
    fail('model.feeders must be a non-empty array');
  }

  const feeders = [];
  const loads = [];
  const loadIndex = new Map();
  const feederIds = new Set();

  for (const rawFeeder of raw.feeders) {
    if (!isPlainObject(rawFeeder)) fail('each feeder must be an object');
    const { id, capacity } = rawFeeder;
    if (typeof id !== 'string' || id.length === 0) fail('feeder.id must be a non-empty string');
    if (feederIds.has(id)) fail(`duplicate feeder id "${id}"`);
    feederIds.add(id);
    if (typeof capacity !== 'number' || !Number.isFinite(capacity) || capacity < 0) {
      fail(`feeder "${id}": capacity must be a non-negative number`);
    }
    if (!Array.isArray(rawFeeder.loads)) fail(`feeder "${id}": loads must be an array`);

    const loadIds = [];
    for (const rawLoad of rawFeeder.loads) {
      if (!isPlainObject(rawLoad)) fail(`feeder "${id}": each load must be an object`);
      const loadId = rawLoad.id;
      if (typeof loadId !== 'string' || loadId.length === 0) {
        fail(`feeder "${id}": load.id must be a non-empty string`);
      }
      if (loadIndex.has(loadId)) fail(`duplicate load id "${loadId}"`);
      const power = rawLoad.power;
      if (typeof power !== 'number' || !Number.isFinite(power)) {
        fail(`load "${loadId}": power must be a finite number`);
      }
      if (power < 0) fail(`load "${loadId}": power must not be negative (got ${power})`);
      const level = rawLoad.level;
      if (!isNonNegativeInteger(level)) {
        fail(`load "${loadId}": level must be a non-negative integer`);
      }
      const maxStage = rawLoad.maxStage;
      if (!Number.isInteger(maxStage) || maxStage < 1) {
        fail(`load "${loadId}": maxStage must be a positive integer (stage domain 0..K)`);
      }
      let fixedStage = null;
      if (rawLoad.stage !== undefined && rawLoad.stage !== null) {
        if (!Number.isInteger(rawLoad.stage)) {
          fail(`load "${loadId}": stage must be an integer in 0..${maxStage}`);
        }
        if (rawLoad.stage < 0 || rawLoad.stage > maxStage) {
          fail(`load "${loadId}": stage ${rawLoad.stage} out of range 0..${maxStage}`);
        }
        fixedStage = rawLoad.stage;
      }
      loadIndex.set(loadId, loads.length);
      loads.push({
        id: loadId,
        power,
        level,
        maxStage,
        fixedStage,
        feederId: id,
        shedPerStage: power / maxStage,
      });
      loadIds.push(loadId);
    }
    feeders.push({ id, capacity, loadIds });
  }

  const interlocks = [];
  const rawInterlocks = raw.interlocks === undefined ? [] : raw.interlocks;
  if (!Array.isArray(rawInterlocks)) fail('model.interlocks must be an array');
  const needLoad = (ref, where) => {
    if (typeof ref !== 'string' || !loadIndex.has(ref)) {
      fail(`${where}: unknown load "${String(ref)}"`);
    }
    return ref;
  };
  for (const rawLock of rawInterlocks) {
    if (!isPlainObject(rawLock)) fail('each interlock must be an object');
    switch (rawLock.type) {
      case 'together': {
        if (!Array.isArray(rawLock.loads) || rawLock.loads.length < 2) {
          fail('interlock "together": loads must be an array of at least 2 load ids');
        }
        const members = rawLock.loads.map((ref, i) => needLoad(ref, `interlock "together" loads[${i}]`));
        if (new Set(members).size !== members.length) {
          fail('interlock "together": duplicate load in group');
        }
        interlocks.push({ type: 'together', loads: members });
        break;
      }
      case 'order': {
        const first = needLoad(rawLock.first, 'interlock "order" first');
        const then = needLoad(rawLock.then, 'interlock "order" then');
        if (first === then) fail('interlock "order": first and then must differ');
        interlocks.push({ type: 'order', first, then });
        break;
      }
      case 'noshed': {
        const load = needLoad(rawLock.load, 'interlock "noshed" load');
        interlocks.push({ type: 'noshed', load });
        break;
      }
      default:
        fail(`unknown interlock type "${String(rawLock.type)}"`);
    }
  }

  return { feeders, loads, loadIndex, interlocks };
}

module.exports = { validateModel, ValidationError };
