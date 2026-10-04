// Model loading and validation.
//
// Model JSON schema:
// {
//   "stages": K,                         // integer, stages are 0..K (0 = nothing shed)
//   "gap": 120,                          // optional default deficit; CLI --gap overrides
//   "feeders": [
//     {
//       "id": "F1",
//       "capacity": [c0, c1, ..., cK],   // cumulative shed allowed on this feeder up to stage s
//       "loads": [
//         {
//           "id": "L1",
//           "power": 50,                 // >= 0
//           "level": 1,                  // importance level, lower = shed first
//           "shed": [0, 20, 50, 50]      // amount shed per stage; array indexed by stage,
//                                        // or object {"0": 0, "1": 20, ...} with integer keys
//         }
//       ]
//     }
//   ],
//   "interlocks": [
//     { "type": "together",    "loads": ["L1", "L2"] },  // identical stages
//     { "type": "sequence",    "loads": ["L1", "L2"] },  // stage(L1) <= stage(L2)
//     { "type": "unsheddable", "loads": ["L3"] }         // forced to stage 0
//   ]
// }

export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
  }
}

function fail(message) {
  throw new ValidationError(message);
}

function isNonNegativeInteger(value) {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function normalizeShed(raw, K, loadId) {
  const shed = new Array(K + 1).fill(null);
  if (Array.isArray(raw)) {
    if (raw.length !== K + 1) {
      fail(`load "${loadId}": shed array length ${raw.length} does not match stages 0..${K}`);
    }
    for (let s = 0; s <= K; s += 1) shed[s] = raw[s];
  } else if (raw !== null && typeof raw === 'object') {
    for (const [key, value] of Object.entries(raw)) {
      const stage = Number(key);
      if (!Number.isInteger(stage)) {
        fail(`load "${loadId}": non-integer stage "${key}"`);
      }
      if (stage < 0 || stage > K) {
        fail(`load "${loadId}": stage ${stage} out of range 0..${K}`);
      }
      shed[stage] = value;
    }
    for (let s = 0; s <= K; s += 1) {
      if (shed[s] === null) fail(`load "${loadId}": missing shed value for stage ${s}`);
    }
  } else {
    fail(`load "${loadId}": shed must be an array or an object`);
  }
  for (let s = 0; s <= K; s += 1) {
    if (!isNonNegativeInteger(shed[s])) {
      fail(`load "${loadId}": shed amount at stage ${s} must be a non-negative integer`);
    }
  }
  if (shed[0] !== 0) fail(`load "${loadId}": shed at stage 0 must be 0`);
  for (let s = 1; s <= K; s += 1) {
    if (shed[s] < shed[s - 1]) {
      fail(`load "${loadId}": shed amounts must be non-decreasing across stages`);
    }
  }
  return shed;
}

export function normalizeModel(data) {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    fail('model must be a JSON object');
  }
  const K = data.stages;
  if (!isNonNegativeInteger(K) || K < 1) fail('"stages" must be a positive integer');

  let gap = null;
  if (data.gap !== undefined) {
    if (!isNonNegativeInteger(data.gap)) fail('"gap" must be a non-negative integer');
    gap = data.gap;
  }

  if (!Array.isArray(data.feeders) || data.feeders.length === 0) {
    fail('"feeders" must be a non-empty array');
  }

  const loads = [];
  const feeders = [];
  const byId = new Map();

  for (const rawFeeder of data.feeders) {
    if (rawFeeder === null || typeof rawFeeder !== 'object') fail('feeder must be an object');
    const feederId = rawFeeder.id;
    if (typeof feederId !== 'string' || feederId === '') fail('feeder "id" must be a non-empty string');
    const cap = rawFeeder.capacity;
    if (!Array.isArray(cap) || cap.length !== K + 1) {
      fail(`feeder "${feederId}": capacity must be an array of length ${K + 1}`);
    }
    const capacity = cap.map((c, s) => {
      if (c === null) return Infinity;
      if (!isNonNegativeInteger(c)) {
        fail(`feeder "${feederId}": capacity at stage ${s} must be a non-negative integer or null`);
      }
      return c;
    });
    if (!Array.isArray(rawFeeder.loads)) fail(`feeder "${feederId}": "loads" must be an array`);

    const feederIndex = feeders.length;
    const loadIndices = [];
    for (const rawLoad of rawFeeder.loads) {
      if (rawLoad === null || typeof rawLoad !== 'object') fail('load must be an object');
      const id = rawLoad.id;
      if (typeof id !== 'string' || id === '') fail('load "id" must be a non-empty string');
      if (byId.has(id)) fail(`duplicate load id "${id}"`);
      const power = rawLoad.power;
      if (typeof power !== 'number' || Number.isNaN(power)) {
        fail(`load "${id}": power must be a number`);
      }
      if (power < 0) fail(`load "${id}": negative power ${power}`);
      if (!isNonNegativeInteger(rawLoad.level)) fail(`load "${id}": level must be a non-negative integer`);
      const shed = normalizeShed(rawLoad.shed, K, id);
      for (let s = 0; s <= K; s += 1) {
        if (shed[s] > power) fail(`load "${id}": shed at stage ${s} exceeds power`);
      }
      byId.set(id, loads.length);
      loadIndices.push(loads.length);
      loads.push({ id, power, level: rawLoad.level, shed, feeder: feederIndex });
    }
    feeders.push({ id: feederId, capacity, loads: loadIndices });
  }

  const interlocks = [];
  for (const raw of data.interlocks ?? []) {
    if (raw === null || typeof raw !== 'object') fail('interlock must be an object');
    const { type } = raw;
    if (!['together', 'sequence', 'unsheddable'].includes(type)) {
      fail(`unknown interlock type "${type}"`);
    }
    if (!Array.isArray(raw.loads) || raw.loads.length === 0) {
      fail(`interlock "${type}": "loads" must be a non-empty array`);
    }
    const indices = raw.loads.map((id) => {
      if (!byId.has(id)) fail(`interlock "${type}": unknown load "${id}"`);
      return byId.get(id);
    });
    if (type === 'sequence' && indices.length !== 2) {
      fail('interlock "sequence" expects exactly 2 loads');
    }
    if (type === 'together' && indices.length < 2) {
      fail('interlock "together" expects at least 2 loads');
    }
    interlocks.push({ type, loads: indices, loadIds: indices.map((i) => loads[i].id) });
  }

  return { stages: K, gap, feeders, loads, interlocks };
}

export function parseModel(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    fail(`invalid JSON: ${err.message}`);
  }
  return normalizeModel(data);
}
