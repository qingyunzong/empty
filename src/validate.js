// Input validation and normalization. All functions are deterministic.

function err(code, message, instructionId) {
  const e = { code, message };
  if (instructionId !== undefined) e.instructionId = instructionId;
  return e;
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function isSafeInt(v) {
  return typeof v === 'number' && Number.isSafeInteger(v);
}

export function normalizeConfig(raw, errors) {
  const config = {
    slots: 0,
    capacityPerSlot: 1,
    quotas: new Map(),
    agingRate: 0,
    exactThreshold: 12,
  };
  if (raw === undefined) {
    errors.push(err('INVALID_INPUT', 'config is required'));
    return config;
  }
  if (!isPlainObject(raw)) {
    errors.push(err('INVALID_INPUT', 'config must be an object'));
    return config;
  }
  if (!isSafeInt(raw.slots) || raw.slots < 1 || raw.slots > 1000000) {
    errors.push(err('INVALID_INPUT', 'config.slots must be an integer >= 1'));
  } else {
    config.slots = raw.slots;
  }
  if (raw.capacityPerSlot !== undefined) {
    if (!isSafeInt(raw.capacityPerSlot) || raw.capacityPerSlot < 1) {
      errors.push(err('INVALID_INPUT', 'config.capacityPerSlot must be an integer >= 1'));
    } else {
      config.capacityPerSlot = raw.capacityPerSlot;
    }
  }
  if (raw.quotas !== undefined) {
    if (!isPlainObject(raw.quotas)) {
      errors.push(err('INVALID_INPUT', 'config.quotas must be an object mapping institution to integer'));
    } else {
      for (const key of Object.keys(raw.quotas).sort()) {
        const q = raw.quotas[key];
        if (!isSafeInt(q) || q < 0) {
          errors.push(err('INVALID_INPUT', `config.quotas["${key}"] must be a non-negative integer`));
        } else {
          config.quotas.set(key, q);
        }
      }
    }
  }
  if (raw.agingRate !== undefined) {
    if (!isSafeInt(raw.agingRate) || raw.agingRate < 0 || raw.agingRate > 1000000000) {
      errors.push(err('INVALID_INPUT', 'config.agingRate must be an integer in [0, 1e9]'));
    } else {
      config.agingRate = raw.agingRate;
    }
  }
  if (raw.exactThreshold !== undefined) {
    if (!isSafeInt(raw.exactThreshold) || raw.exactThreshold < 0 || raw.exactThreshold > 20) {
      errors.push(err('INVALID_INPUT', 'config.exactThreshold must be an integer in [0, 20]'));
    } else {
      config.exactThreshold = raw.exactThreshold;
    }
  }
  return config;
}

export function normalizeInstruction(raw, index, slots, errors) {
  const label = isPlainObject(raw) && typeof raw.id === 'string' ? raw.id : `#${index}`;
  if (!isPlainObject(raw)) {
    errors.push(err('INVALID_INPUT', `instructions[${index}] must be an object`));
    return null;
  }
  let ok = true;
  const fail = (msg) => { errors.push(err('INVALID_INPUT', msg, typeof raw.id === 'string' ? raw.id : undefined)); ok = false; };
  if (typeof raw.id !== 'string' || raw.id.length === 0) fail(`instructions[${index}].id must be a non-empty string`);
  if (typeof raw.institution !== 'string' || raw.institution.length === 0) fail(`instruction ${label}: institution must be a non-empty string`);
  if (typeof raw.amount !== 'number' || !Number.isFinite(raw.amount) || raw.amount < 0) fail(`instruction ${label}: amount must be a finite number >= 0`);
  if (!isSafeInt(raw.priority) || Math.abs(raw.priority) > 1000000000) fail(`instruction ${label}: priority must be a safe integer with |priority| <= 1e9`);
  if (!isSafeInt(raw.deadlineSlot) || raw.deadlineSlot < 1 || raw.deadlineSlot > slots) fail(`instruction ${label}: deadlineSlot must be an integer in [1, ${slots}]`);
  let arrivalSlot = 1;
  if (raw.arrivalSlot !== undefined) {
    if (!isSafeInt(raw.arrivalSlot) || raw.arrivalSlot < 0 || raw.arrivalSlot > slots) {
      fail(`instruction ${label}: arrivalSlot must be an integer in [0, ${slots}]`);
    } else {
      arrivalSlot = raw.arrivalSlot;
    }
  }
  if (ok && arrivalSlot > raw.deadlineSlot) fail(`instruction ${label}: arrivalSlot must be <= deadlineSlot`);
  let dependencies = [];
  if (raw.dependencies !== undefined) {
    if (!Array.isArray(raw.dependencies) || raw.dependencies.some((d) => typeof d !== 'string' || d.length === 0)) {
      fail(`instruction ${label}: dependencies must be an array of non-empty strings`);
    } else {
      const seen = new Set(raw.dependencies);
      if (seen.size !== raw.dependencies.length) fail(`instruction ${label}: dependencies contain duplicates`);
      dependencies = [...raw.dependencies].sort();
    }
  }
  if (!ok) return null;
  return {
    id: raw.id,
    institution: raw.institution,
    amount: raw.amount,
    priority: raw.priority,
    deadlineSlot: raw.deadlineSlot,
    arrivalSlot,
    dependencies,
  };
}

// Returns the set of instruction ids that are part of, or transitively depend
// on, a dependency cycle.
export function findCycleTainted(instructions) {
  const deps = new Map(instructions.map((i) => [i.id, i.dependencies.filter((d) => d !== i.id)]));
  const inCycle = new Set();
  // A node is in a cycle iff it can reach itself (self-loops handled above).
  for (const instr of instructions) {
    if (instr.dependencies.includes(instr.id)) inCycle.add(instr.id);
  }
  for (const instr of instructions) {
    if (inCycle.has(instr.id)) continue;
    const seen = new Set();
    const stack = [...(deps.get(instr.id) ?? [])];
    let reachesSelf = false;
    while (stack.length > 0) {
      const cur = stack.pop();
      if (cur === instr.id) { reachesSelf = true; break; }
      if (seen.has(cur)) continue;
      seen.add(cur);
      const next = deps.get(cur);
      if (next) for (const d of next) stack.push(d);
    }
    if (reachesSelf) inCycle.add(instr.id);
  }
  // Taint: anything transitively depending on a cyclic instruction.
  const dependents = new Map(instructions.map((i) => [i.id, []]));
  for (const i of instructions) {
    for (const d of i.dependencies) {
      if (dependents.has(d)) dependents.get(d).push(i.id);
    }
  }
  const tainted = new Set(inCycle);
  const queue = [...inCycle];
  while (queue.length > 0) {
    const cur = queue.shift();
    for (const dep of dependents.get(cur) ?? []) {
      if (!tainted.has(dep)) {
        tainted.add(dep);
        queue.push(dep);
      }
    }
  }
  return { inCycle, tainted };
}

// Validates the raw CLI/library input. Returns { ok, errors, value }.
// Non-fatal graph problems (MISSING_DEP, CYCLE) are reported in errors and the
// affected instruction ids are returned in `excluded` so the caller can still
// schedule the rest.
export function validateInput(raw) {
  const errors = [];
  if (!isPlainObject(raw)) {
    return { ok: false, errors: [err('INVALID_INPUT', 'input must be a JSON object')], value: null };
  }
  const config = normalizeConfig(raw.config, errors);
  if (!Array.isArray(raw.instructions)) {
    errors.push(err('INVALID_INPUT', 'instructions must be an array'));
    return { ok: false, errors, value: null };
  }
  const instructions = [];
  const seenIds = new Set();
  for (let idx = 0; idx < raw.instructions.length; idx++) {
    const instr = normalizeInstruction(raw.instructions[idx], idx, Math.max(config.slots, 1), errors);
    if (instr === null) continue;
    if (seenIds.has(instr.id)) {
      errors.push(err('INVALID_INPUT', `duplicate instruction id "${instr.id}"`, instr.id));
      continue;
    }
    seenIds.add(instr.id);
    instructions.push(instr);
  }
  if (errors.length > 0) return { ok: false, errors, value: null };

  instructions.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const excluded = new Set();
  const byId = new Map(instructions.map((i) => [i.id, i]));
  for (const instr of instructions) {
    const missing = instr.dependencies.filter((d) => !byId.has(d));
    if (missing.length > 0) {
      errors.push(err('MISSING_DEP', `instruction ${instr.id} depends on unknown instruction(s): ${missing.join(', ')}`, instr.id));
      excluded.add(instr.id);
    }
  }
  const { inCycle, tainted } = findCycleTainted(instructions.filter((i) => !excluded.has(i.id)));
  for (const id of [...tainted].sort()) {
    errors.push(err('CYCLE', inCycle.has(id)
      ? `instruction ${id} is part of a dependency cycle`
      : `instruction ${id} transitively depends on a dependency cycle`, id));
    excluded.add(id);
  }

  let undo = [];
  if (raw.undo !== undefined) {
    if (!Array.isArray(raw.undo) || raw.undo.some((u) => typeof u !== 'string')) {
      return { ok: false, errors: [err('INVALID_INPUT', 'undo must be an array of instruction ids')], value: null };
    }
    undo = [...raw.undo];
  }

  return { ok: true, errors, value: { config, instructions, undo, excluded } };
}
