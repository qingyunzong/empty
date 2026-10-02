import { ClearingError } from './errors.js';

function fail(code, message) {
  throw new ClearingError(code, message);
}

export function normalizeScenario(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    fail('INVALID', 'scenario must be an object');
  }
  const { capacity } = input;
  if (!Number.isInteger(capacity) || capacity <= 0) {
    fail('INVALID', 'capacity must be a positive integer');
  }
  let agingLimit = input.agingLimit ?? null;
  if (agingLimit !== null && (!Number.isInteger(agingLimit) || agingLimit < 0)) {
    fail('INVALID', 'agingLimit must be a non-negative integer or null');
  }
  if (agingLimit === null) agingLimit = Infinity;

  const institutions = new Map();
  for (const [name, cfg] of Object.entries(input.institutions ?? {})) {
    const quota = typeof cfg === 'number' ? cfg : cfg && cfg.quota;
    if (!Number.isInteger(quota) || quota < 0) {
      fail('INVALID', `institution "${name}" has invalid quota`);
    }
    institutions.set(name, { name, quota });
  }

  const seen = new Set();
  const batches = (input.batches ?? []).map((raw, index) => {
    if (!raw || typeof raw !== 'object') fail('INVALID', `batch #${index} is invalid`);
    const id = raw.id;
    if (typeof id !== 'string' || id.length === 0) fail('INVALID', `batch #${index} is missing an id`);
    if (seen.has(id)) fail('INVALID', `duplicate batch id "${id}"`);
    seen.add(id);
    const institution = raw.institution;
    if (!institutions.has(institution)) {
      fail('INVALID', `batch "${id}" references unknown institution "${institution}"`);
    }
    const priority = raw.priority ?? 0;
    if (!Number.isInteger(priority)) fail('INVALID', `batch "${id}" priority must be an integer`);
    const amount = raw.amount;
    if (!Number.isInteger(amount) || amount <= 0) {
      fail('INVALID', `batch "${id}" amount must be a positive integer`);
    }
    const arrivalRound = raw.arrivalRound ?? 1;
    if (!Number.isInteger(arrivalRound) || arrivalRound < 1) {
      fail('INVALID', `batch "${id}" arrivalRound must be a positive integer`);
    }
    let group = raw.group ?? null;
    if (raw.atomic === true && group === null) group = `atomic:${id}`;
    if (group !== null && typeof group !== 'string') {
      fail('INVALID', `batch "${id}" group must be a string`);
    }
    return { id, institution, priority, amount, arrivalRound, group, index };
  });

  const groups = new Map();
  for (const b of batches) {
    if (b.group === null) continue;
    if (!groups.has(b.group)) {
      groups.set(b.group, {
        id: b.group,
        institution: b.institution,
        members: [],
        total: 0,
        priority: -Infinity,
        arrivalRound: 1,
        index: b.index,
      });
    }
    const g = groups.get(b.group);
    if (g.institution !== b.institution) {
      fail('ATOMIC_SPLIT', `atomic group "${g.id}" spans multiple institutions`);
    }
    g.members.push(b.id);
    g.total += b.amount;
    g.priority = Math.max(g.priority, b.priority);
    g.arrivalRound = Math.max(g.arrivalRound, b.arrivalRound);
    g.index = Math.min(g.index, b.index);
  }
  for (const g of groups.values()) {
    if (g.total > capacity) {
      fail('ATOMIC_SPLIT', `atomic group "${g.id}" total ${g.total} exceeds window capacity ${capacity}`);
    }
    const quota = institutions.get(g.institution).quota;
    if (g.total > quota) {
      fail('QUOTA', `atomic group "${g.id}" total ${g.total} exceeds per-round quota ${quota} of institution "${g.institution}"`);
    }
  }
  for (const b of batches) {
    if (institutions.get(b.institution).quota === 0) {
      fail('QUOTA', `institution "${b.institution}" has zero quota; batch "${b.id}" can never be scheduled`);
    }
  }
  return { capacity, agingLimit, institutions, batches, groups };
}

export function canonicalScenario(sc) {
  return {
    capacity: sc.capacity,
    agingLimit: sc.agingLimit === Infinity ? null : sc.agingLimit,
    institutions: Object.fromEntries([...sc.institutions.values()].map((i) => [i.name, i.quota])),
    batches: sc.batches.map((b) => ({
      id: b.id,
      institution: b.institution,
      priority: b.priority,
      amount: b.amount,
      arrivalRound: b.arrivalRound,
      group: b.group,
    })),
  };
}
