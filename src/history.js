import { InvalidHistory } from './errors.js';

const OP_TYPES = new Set(['set_count', 'move_plot', 'morph_species', 'sync', 'undo_op']);

export function validateConfig(config) {
  const fail = (m) => { throw new InvalidHistory(`config: ${m}`); };
  if (!config || typeof config !== 'object') fail('must be an object');
  if (!Array.isArray(config.species) || config.species.length === 0) fail('species must be a non-empty array');
  if (!Array.isArray(config.plots) || config.plots.length === 0) fail('plots must be a non-empty array');
  if (!Number.isInteger(config.maxTier) || config.maxTier < 0) fail('maxTier must be a non-negative integer');
  const species = new Map();
  for (const s of config.species) {
    if (!s || typeof s.id !== 'string' || typeof s.morph !== 'string') fail('each species needs string id and morph');
    if (species.has(s.id)) fail(`duplicate species ${s.id}`);
    species.set(s.id, s.morph);
  }
  const plots = new Map();
  for (const p of config.plots) {
    if (!p || typeof p.id !== 'string' || !Number.isInteger(p.area) || p.area < 0) {
      fail('each plot needs string id and non-negative integer area');
    }
    if (plots.has(p.id)) fail(`duplicate plot ${p.id}`);
    plots.set(p.id, p.area);
  }
  return { species, plots, maxTier: config.maxTier };
}

function checkOp(raw, where, domain) {
  const fail = (m) => { throw new InvalidHistory(`${where}: ${m}`); };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('op must be a JSON object');
  const { id, device, ts, op } = raw;
  if (typeof id !== 'string' || id === '') fail('missing op id');
  if (typeof device !== 'string' || device === '') fail(`op ${id}: missing device`);
  if (!Number.isInteger(ts)) fail(`op ${id}: ts must be an integer`);
  if (!OP_TYPES.has(op)) fail(`op ${id}: unknown op type ${JSON.stringify(op)}`);
  const needSpecies = (key) => {
    if (typeof raw[key] !== 'string' || !domain.species.has(raw[key])) {
      fail(`op ${id}: unknown species in field ${key}`);
    }
  };
  switch (op) {
    case 'set_count':
      if (typeof raw.plot !== 'string' || !domain.plots.has(raw.plot)) fail(`op ${id}: unknown plot`);
      needSpecies('species');
      if (!Number.isInteger(raw.tier) || raw.tier < 0 || raw.tier > domain.maxTier) {
        fail(`op ${id}: tier out of range [0, ${domain.maxTier}]`);
      }
      break;
    case 'move_plot':
      if (typeof raw.plot !== 'string' || !domain.plots.has(raw.plot)) fail(`op ${id}: unknown plot`);
      needSpecies('from');
      needSpecies('to');
      if (raw.from === raw.to) fail(`op ${id}: from and to species must differ`);
      if (!Number.isInteger(raw.count) || raw.count <= 0) fail(`op ${id}: count must be a positive integer`);
      break;
    case 'morph_species':
      needSpecies('from');
      needSpecies('to');
      if (raw.from === raw.to) fail(`op ${id}: from and to species must differ`);
      if (domain.species.get(raw.from) !== domain.species.get(raw.to)) {
        fail(`op ${id}: morph-incompatible rename ${raw.from} -> ${raw.to}`);
      }
      break;
    case 'sync':
      if (typeof raw.with !== 'string' || raw.with === '') fail(`op ${id}: sync needs a peer device in "with"`);
      if (raw.with === device) fail(`op ${id}: cannot sync with itself`);
      if (typeof raw.mark !== 'string' || raw.mark === '') fail(`op ${id}: sync needs a mark`);
      break;
    case 'undo_op':
      if (typeof raw.target !== 'string' || raw.target === '') fail(`op ${id}: undo_op needs a target id`);
      break;
  }
  return raw;
}

// Parse JSONL text lines into validated ops, grouped per device in file order.
export function parseHistories(inputs, domain) {
  // inputs: [{name, text}]
  const byDevice = new Map();
  const seenIds = new Set();
  for (const { name, text } of inputs) {
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line === '') continue;
      let raw;
      try {
        raw = JSON.parse(line);
      } catch (e) {
        throw new InvalidHistory(`${name}:${i + 1}: invalid JSON: ${e.message}`);
      }
      const op = checkOp(raw, `${name}:${i + 1}`, domain);
      if (seenIds.has(op.id)) throw new InvalidHistory(`${name}:${i + 1}: duplicate op id ${op.id}`);
      seenIds.add(op.id);
      if (!byDevice.has(op.device)) byDevice.set(op.device, []);
      byDevice.get(op.device).push(op);
    }
  }
  if (byDevice.size === 0) throw new InvalidHistory('no operations found');
  // per-device monotonic time
  for (const [dev, ops] of byDevice) {
    for (let i = 1; i < ops.length; i++) {
      if (ops[i].ts <= ops[i - 1].ts) {
        throw new InvalidHistory(`device ${dev}: non-monotonic ts at op ${ops[i].id} (ts ${ops[i].ts} after ${ops[i - 1].ts})`);
      }
    }
  }
  return byDevice;
}

// Undo discipline: undo_op may only retract the latest still-effective
// unsynced op on the same device (stack discipline). Returns effective ops
// per device with undone targets and undo ops removed.
export function unwindUndos(byDevice) {
  const result = new Map();
  for (const [dev, ops] of byDevice) {
    const stack = [];
    for (const op of ops) {
      if (op.op === 'sync') {
        stack.push(op); // syncs are barriers; not undoable, kept
        continue;
      }
      if (op.op === 'undo_op') {
        // find topmost effective non-sync op
        let top = stack.length - 1;
        while (top >= 0 && stack[top].op === 'sync') top--;
        if (top < 0) throw new InvalidHistory(`device ${dev}: undo_op ${op.id} has no unsynced op to retract`);
        const target = stack[top];
        if (target.id !== op.target) {
          throw new InvalidHistory(
            `device ${dev}: undo_op ${op.id} targets ${op.target} but latest unsynced op is ${target.id}`
          );
        }
        // any sync between target and undo?
        if (stack[stack.length - 1].op === 'sync' && stack.length - 1 > top) {
          throw new InvalidHistory(`device ${dev}: undo_op ${op.id} targets already-synced op ${op.target}`);
        }
        stack.splice(top, 1); // retract target; undo op itself vanishes
        continue;
      }
      stack.push(op);
    }
    result.set(dev, stack);
  }
  return result;
}

// Pair sync rendezvous ops across devices. Returns list of [idA, idB].
export function pairSyncs(byDevice) {
  const pendings = new Map(); // key -> {id, device}
  const pairs = [];
  for (const [dev, ops] of byDevice) {
    for (const op of ops) {
      if (op.op !== 'sync') continue;
      const key = `${[dev, op.with].sort().join('|')}::${op.mark}`;
      const pending = pendings.get(key);
      if (!pending) {
        pendings.set(key, { id: op.id, device: dev });
      } else if (pending.device === dev) {
        throw new InvalidHistory(`sync mark ${op.mark}: duplicate rendezvous on device ${dev}`);
      } else {
        pairs.push([pending.id, op.id]);
        pendings.delete(key);
      }
    }
  }
  if (pendings.size > 0) {
    const leftover = [...pendings.values()][0];
    throw new InvalidHistory(`sync op ${leftover.id} on device ${leftover.device} has no matching peer`);
  }
  return pairs;
}
