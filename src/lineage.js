// Batch lineage: records -> validated traceability view.
//
// A batch record is:
//   { batch, parents?, defects?, pending?, on? }
// - parents: lineage edges (provenance). Must reference known batches and
//   form a DAG, otherwise CyclicLineageError / UnknownParentError.
// - defects: defect ids observed on this batch.
// - pending: inspection outcome undecided; the batch still counts as a real
//   view state (never treated as unsatisfiable).
// - on: processing transitions over merge/split/test/ship.
//
// The view state label is the reachable defect closure: the batch's own
// defects unioned with every ancestor's defects.

import { CyclicLineageError, UnknownParentError, ValidationError } from './errors.js';
import { DEFAULT_ALPHABET, makeView } from './dfa.js';

export function normalizeBatchRecord(raw, index = '?') {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ValidationError(`record ${index}: batch record must be an object`);
  }
  if (typeof raw.batch !== 'string' || raw.batch.length === 0) {
    throw new ValidationError(`record ${index}: "batch" must be a non-empty string`);
  }
  const parents = raw.parents ?? [];
  const defects = raw.defects ?? [];
  const pending = raw.pending ?? false;
  const on = raw.on ?? {};
  if (!Array.isArray(parents) || parents.some((p) => typeof p !== 'string')) {
    throw new ValidationError(`batch "${raw.batch}": "parents" must be an array of strings`);
  }
  if (!Array.isArray(defects) || defects.some((d) => typeof d !== 'string')) {
    throw new ValidationError(`batch "${raw.batch}": "defects" must be an array of strings`);
  }
  if (typeof pending !== 'boolean') {
    throw new ValidationError(`batch "${raw.batch}": "pending" must be a boolean`);
  }
  if (on === null || typeof on !== 'object' || Array.isArray(on)
      || Object.values(on).some((t) => typeof t !== 'string')) {
    throw new ValidationError(`batch "${raw.batch}": "on" must map symbols to batch names`);
  }
  return { batch: raw.batch, parents, defects, pending, on };
}

function indexRecords(records, alphabet) {
  const batches = new Map();
  records.forEach((raw, i) => {
    const rec = normalizeBatchRecord(raw, i);
    if (batches.has(rec.batch)) {
      throw new ValidationError(`duplicate batch "${rec.batch}"`);
    }
    batches.set(rec.batch, rec);
  });
  for (const rec of batches.values()) {
    for (const parent of rec.parents) {
      if (!batches.has(parent)) {
        throw new UnknownParentError(
          `batch "${rec.batch}" references unknown parent batch "${parent}"`,
        );
      }
    }
    for (const [symbol, target] of Object.entries(rec.on)) {
      if (!alphabet.includes(symbol)) {
        throw new ValidationError(`batch "${rec.batch}" uses unknown symbol "${symbol}"`);
      }
      if (!batches.has(target)) {
        throw new UnknownParentError(
          `batch "${rec.batch}" transitions on "${symbol}" to unknown batch "${target}"`,
        );
      }
    }
  }
  return batches;
}

// Memoized defect closure over the parent DAG. Detects cycles on the way.
export function defectClosures(records, alphabet = DEFAULT_ALPHABET) {
  const batches = indexRecords(records, alphabet);
  const closures = new Map();
  const visiting = new Set();
  const close = (name, trail) => {
    if (closures.has(name)) return closures.get(name);
    if (visiting.has(name)) {
      const cycle = [...trail, name].join(' -> ');
      throw new CyclicLineageError(`cyclic lineage detected: ${cycle}`);
    }
    visiting.add(name);
    const rec = batches.get(name);
    const out = new Set(rec.defects);
    for (const parent of rec.parents) {
      for (const d of close(parent, [...trail, name])) out.add(d);
    }
    visiting.delete(name);
    const sorted = [...out].sort();
    closures.set(name, sorted);
    return sorted;
  };
  for (const name of batches.keys()) close(name, []);
  return closures;
}

export function buildView(records, { start, alphabet = DEFAULT_ALPHABET } = {}) {
  const batches = indexRecords(records, alphabet);
  const closures = defectClosures(records, alphabet);
  const view = makeView(alphabet);
  for (const rec of batches.values()) {
    view.states.set(rec.batch, {
      defects: closures.get(rec.batch),
      pending: rec.pending,
      on: new Map(Object.entries(rec.on)),
    });
  }
  const fallbackStart = batches.size > 0 ? batches.keys().next().value : null;
  view.start = start ?? fallbackStart;
  if (view.start !== null && !view.states.has(view.start)) {
    throw new ValidationError(`start batch "${view.start}" is not a known batch`);
  }
  return view;
}
