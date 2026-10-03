export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
  }
}

const STATUSES = new Set(['released', 'quarantined']);

function requireId(value, kind) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ValidationError(`${kind} id must be a non-empty string, got ${JSON.stringify(value)}`);
  }
  return value;
}

function requireNonNegInt(value, field, id) {
  if (!Number.isInteger(value) || value < 0) {
    throw new ValidationError(`${id}: ${field} must be a non-negative integer, got ${JSON.stringify(value)}`);
  }
  return value;
}

function requirePosInt(value, field, id) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new ValidationError(`${id}: ${field} must be a positive integer, got ${JSON.stringify(value)}`);
  }
  return value;
}

function requireDate(value, field, id) {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new ValidationError(`${id}: ${field} must be a valid ISO date string, got ${JSON.stringify(value)}`);
  }
  return Date.parse(value);
}

function requireStatus(value, id) {
  const status = value === undefined ? 'released' : value;
  if (!STATUSES.has(status)) {
    throw new ValidationError(`${id}: status must be one of released|quarantined, got ${JSON.stringify(value)}`);
  }
  return status;
}

export function validateMaterial(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ValidationError(`material must be an object, got ${JSON.stringify(raw)}`);
  }
  const id = requireId(raw.id, 'material');
  return {
    id,
    quantity: requireNonNegInt(raw.quantity, 'quantity', id),
    expiry: raw.expiry,
    expiryMs: requireDate(raw.expiry, 'expiry', id),
    status: requireStatus(raw.status, id),
  };
}

export function validateBatch(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ValidationError(`batch must be an object, got ${JSON.stringify(raw)}`);
  }
  const id = requireId(raw.id, 'batch');
  if (typeof raw.line !== 'string' || raw.line.length === 0) {
    throw new ValidationError(`${id}: line must be a non-empty string`);
  }
  const startMs = requireDate(raw.start, 'start', id);
  const endMs = requireDate(raw.end, 'end', id);
  if (endMs < startMs) {
    throw new ValidationError(`${id}: end must not be before start`);
  }
  if (!Array.isArray(raw.candidates)) {
    throw new ValidationError(`${id}: candidates must be an array of parent ids`);
  }
  const candidates = raw.candidates.map((p) => requireId(p, `${id} candidate`));
  if (new Set(candidates).size !== candidates.length) {
    throw new ValidationError(`${id}: candidates must not contain duplicates`);
  }
  if (candidates.includes(id)) {
    throw new ValidationError(`${id}: a batch cannot be its own candidate parent`);
  }
  return {
    id,
    line: raw.line,
    start: raw.start,
    end: raw.end,
    startMs,
    endMs,
    output: requirePosInt(raw.output, 'output', id),
    loss: requireNonNegInt(raw.loss, 'loss', id),
    expiry: raw.expiry,
    expiryMs: requireDate(raw.expiry, 'expiry', id),
    candidates,
    status: requireStatus(raw.status, id),
  };
}

export function validateInput(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ValidationError('input must be a JSON object');
  }
  if (raw.materials !== undefined && !Array.isArray(raw.materials)) {
    throw new ValidationError('materials must be an array');
  }
  if (raw.batches !== undefined && !Array.isArray(raw.batches)) {
    throw new ValidationError('batches must be an array');
  }
  const materials = (raw.materials ?? []).map(validateMaterial);
  const batches = (raw.batches ?? []).map(validateBatch);

  const kinds = new Map();
  for (const m of materials) {
    if (kinds.has(m.id)) throw new ValidationError(`duplicate id ${m.id}`);
    kinds.set(m.id, 'material');
  }
  for (const b of batches) {
    if (kinds.has(b.id)) throw new ValidationError(`duplicate id ${b.id}`);
    kinds.set(b.id, 'batch');
  }
  for (const b of batches) {
    for (const p of b.candidates) {
      if (!kinds.has(p)) {
        throw new ValidationError(`${b.id}: broken reference to unknown candidate parent ${p}`);
      }
    }
  }

  const batchMap = new Map(batches.map((b) => [b.id, b]));
  const mark = new Map();
  const visit = (id, stack) => {
    const state = mark.get(id) ?? 0;
    if (state === 1) {
      throw new ValidationError(`cycle detected in genealogy: ${[...stack, id].join(' -> ')}`);
    }
    if (state === 2) return;
    mark.set(id, 1);
    for (const p of batchMap.get(id).candidates) {
      if (batchMap.has(p)) visit(p, [...stack, id]);
    }
    mark.set(id, 2);
  };
  for (const b of batches) visit(b.id, []);

  let budget;
  if (raw.budget !== undefined) {
    budget = requireNonNegInt(raw.budget, 'budget', 'input');
  }
  return { materials, batches, budget };
}
