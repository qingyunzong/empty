'use strict';
// Food/chemical plant offline lineage tracing: raw material -> finished product.
// Pure standard library. Lineage is a DAG; mix/split keep causal edges.
// Inspection corrections append compensation nodes (history is never deleted)
// and trigger an incremental recompute of the contamination closure.
// Scrap uses a tombstone: it blocks downstream propagation but never erases
// upstream evidence.

const crypto = require('node:crypto');

const RULES_VERSION = '1.0.0';
const STATE_FORMAT = 1;

const EXIT_ERROR = 1;
const EXIT_CYCLE = 6;
const EXIT_DANGLING = 7;

class TraceError extends Error {
  constructor(message, exitCode) {
    super(message);
    this.name = 'TraceError';
    this.exitCode = exitCode;
  }
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = sortKeys(value[key]);
    return out;
  }
  return value;
}

function canonicalEvent(event) {
  return JSON.stringify(sortKeys(event));
}

function hashEvents(events) {
  const hash = crypto.createHash('sha256');
  for (const event of events) hash.update(canonicalEvent(event) + '\n');
  return 'sha256:' + hash.digest('hex');
}

function parseJsonl(text) {
  const events = [];
  text.split(/\r?\n/).forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    let event;
    try {
      event = JSON.parse(trimmed);
    } catch (err) {
      throw new TraceError(`line ${index + 1}: invalid JSON: ${err.message}`, EXIT_ERROR);
    }
    if (event === null || typeof event !== 'object' || Array.isArray(event)) {
      throw new TraceError(`line ${index + 1}: event must be a JSON object`, EXIT_ERROR);
    }
    events.push(event);
  });
  return events;
}

// Unknown inspection statuses are recorded as "unknown" and are never
// treated as a failure.
function normalizeStatus(status) {
  return status === 'pass' || status === 'fail' ? status : 'unknown';
}

function effectiveStatus(inspection) {
  const raw = inspection.correction ? inspection.correction.status : inspection.status;
  return normalizeStatus(raw);
}

function emptyState() {
  return {
    events: [],
    batches: new Map(),     // id -> {id, kind, parents, children, inspections, scrapped, scrapReason}
    inspections: new Map(), // id -> {id, batch, test, status, correction}
    topo: [],               // batch ids in topological order
    contaminated: new Set(),
  };
}

function requireId(value, what) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TraceError(`${what} requires a non-empty string id`, EXIT_ERROR);
  }
  return value;
}

function declareBatch(state, id, kind) {
  requireId(id, `${kind} event`);
  if (state.batches.has(id)) {
    throw new TraceError(`duplicate batch "${id}"`, EXIT_ERROR);
  }
  state.batches.set(id, {
    id,
    kind,
    parents: [],
    children: [],
    inspections: [],
    scrapped: false,
    scrapReason: null,
  });
}

function requireBatch(state, id, what) {
  const batch = state.batches.get(id);
  if (!batch) {
    throw new TraceError(`${what} references unknown batch "${id}"`, EXIT_DANGLING);
  }
  return batch;
}

function addEdge(state, from, to) {
  const parent = requireBatch(state, from, 'edge');
  const child = requireBatch(state, to, 'edge');
  parent.children.push(to);
  child.parents.push(from);
}

function topoSort(state) {
  const indegree = new Map();
  for (const [id, batch] of state.batches) indegree.set(id, batch.parents.length);
  const ready = [...state.batches.keys()].filter((id) => indegree.get(id) === 0).sort();
  const order = [];
  while (ready.length > 0) {
    const id = ready.shift();
    order.push(id);
    for (const child of state.batches.get(id).children) {
      indegree.set(child, indegree.get(child) - 1);
      if (indegree.get(child) === 0) {
        ready.push(child);
        ready.sort();
      }
    }
  }
  if (order.length !== state.batches.size) {
    const inOrder = new Set(order);
    const remaining = [...state.batches.keys()].filter((id) => !inOrder.has(id)).sort();
    throw new TraceError(`cycle detected among batches: ${remaining.join(', ')}`, EXIT_CYCLE);
  }
  return order;
}

// Applies events to the state. Batches are declared first, then edges are
// resolved against the full batch set (so forward references resolve), then
// inspections/corrections/scraps are applied in log order.
function applyEvents(state, events) {
  for (const event of events) {
    switch (event.type) {
      case 'intake':
        declareBatch(state, event.batch, 'intake');
        break;
      case 'mix':
        declareBatch(state, event.output, 'mix');
        break;
      case 'split':
        for (const output of event.outputs || []) declareBatch(state, output, 'split');
        break;
      case 'inspect':
      case 'correct':
      case 'scrap':
        break;
      default:
        throw new TraceError(`unknown event type "${event.type}"`, EXIT_ERROR);
    }
  }

  for (const event of events) {
    if (event.type === 'mix') {
      if (!Array.isArray(event.inputs) || event.inputs.length === 0) {
        throw new TraceError(`mix "${event.output}" requires a non-empty inputs array`, EXIT_ERROR);
      }
      for (const input of event.inputs) addEdge(state, input, event.output);
    } else if (event.type === 'split') {
      requireId(event.input, 'split event');
      if (!Array.isArray(event.outputs) || event.outputs.length === 0) {
        throw new TraceError('split requires a non-empty outputs array', EXIT_ERROR);
      }
      for (const output of event.outputs) addEdge(state, event.input, output);
    }
  }

  state.topo = topoSort(state);

  for (const event of events) {
    if (event.type === 'inspect') {
      requireId(event.id, 'inspect event');
      if (state.inspections.has(event.id)) {
        throw new TraceError(`duplicate inspection "${event.id}"`, EXIT_ERROR);
      }
      const batch = requireBatch(state, event.batch, `inspect "${event.id}"`);
      const inspection = {
        id: event.id,
        batch: batch.id,
        test: typeof event.test === 'string' ? event.test : null,
        status: event.status,
        correction: null,
      };
      state.inspections.set(inspection.id, inspection);
      batch.inspections.push(inspection);
    } else if (event.type === 'correct') {
      requireId(event.inspection, 'correct event');
      const inspection = state.inspections.get(event.inspection);
      if (!inspection) {
        throw new TraceError(`correct references unknown inspection "${event.inspection}"`, EXIT_DANGLING);
      }
      // Compensation node: the original inspection is kept untouched.
      inspection.correction = {
        status: event.status,
        reason: typeof event.reason === 'string' ? event.reason : null,
      };
    } else if (event.type === 'scrap') {
      const batch = requireBatch(state, event.batch, 'scrap');
      if (batch.scrapped) {
        throw new TraceError(`batch "${batch.id}" is already scrapped`, EXIT_ERROR);
      }
      batch.scrapped = true;
      batch.scrapReason = typeof event.reason === 'string' ? event.reason : null;
    }
  }
  state.events.push(...events);
  return state;
}

function buildState(events) {
  const state = emptyState();
  applyEvents(state, events);
  state.contaminated = computeContamination(state);
  return state;
}

function isSelfFailing(batch) {
  return batch.inspections.some((inspection) => effectiveStatus(inspection) === 'fail');
}

// A batch is contaminated when its own effective inspection failed, or when a
// parent is contaminated and that parent is not tombstoned. A tombstone stops
// propagation past the scrapped batch but never clears the batch itself.
function isContaminated(state, id, contaminated) {
  const batch = state.batches.get(id);
  if (isSelfFailing(batch)) return true;
  for (const parentId of batch.parents) {
    const parent = state.batches.get(parentId);
    if (contaminated.has(parentId) && !parent.scrapped) return true;
  }
  return false;
}

function computeContamination(state) {
  const contaminated = new Set();
  for (const id of state.topo) {
    if (isContaminated(state, id, contaminated)) contaminated.add(id);
  }
  return contaminated;
}

function downstreamClosure(state, origin) {
  const seen = new Set([origin]);
  const stack = [origin];
  while (stack.length > 0) {
    for (const child of state.batches.get(stack.pop()).children) {
      if (!seen.has(child)) {
        seen.add(child);
        stack.push(child);
      }
    }
  }
  return seen;
}

// Incremental recompute: only nodes inside the closure are re-evaluated;
// nodes outside keep their previous verdict.
function recomputeClosure(state, closure) {
  for (const id of state.topo) {
    if (!closure.has(id)) continue;
    if (isContaminated(state, id, state.contaminated)) {
      state.contaminated.add(id);
    } else {
      state.contaminated.delete(id);
    }
  }
}

// Appends a compensation correction event and incrementally recomputes the
// contamination closure of the inspected batch.
function correctInspection(state, inspectionId, status, reason) {
  const inspection = state.inspections.get(inspectionId);
  if (!inspection) {
    throw new TraceError(`correct references unknown inspection "${inspectionId}"`, EXIT_DANGLING);
  }
  const event = {
    type: 'correct',
    inspection: inspectionId,
    status,
    reason: typeof reason === 'string' ? reason : null,
  };
  const before = new Set(state.contaminated);
  inspection.correction = { status, reason: event.reason };
  state.events.push(event);
  const closure = downstreamClosure(state, inspection.batch);
  recomputeClosure(state, closure);
  const added = [...state.contaminated].filter((id) => !before.has(id)).sort();
  const removed = [...before].filter((id) => !state.contaminated.has(id)).sort();
  return { event, added, removed, closure: [...closure].sort() };
}

// Adds new events (e.g. a split registered after a scrap) and recomputes.
function appendEvents(state, events) {
  applyEvents(state, events);
  state.contaminated = computeContamination(state);
  return state;
}

function sortedSet(set) {
  return [...set].sort();
}

function buildCertificate(state) {
  const contaminated = state.contaminated;
  const affected = sortedSet(contaminated);
  const products = affected.filter((id) => state.batches.get(id).children.length === 0);
  // Earliest contamination sources: contaminated batches with no transmitting
  // contaminated parent. Ties are ordered lexicographically by batch id.
  const sources = affected
    .filter((id) => {
      const batch = state.batches.get(id);
      return !batch.parents.some(
        (parentId) => contaminated.has(parentId) && !state.batches.get(parentId).scrapped,
      );
    })
    .sort();
  // Affected boundary: contaminated batches with no contaminated child.
  const boundary = affected
    .filter((id) => !state.batches.get(id).children.some((child) => contaminated.has(child)))
    .map((id) => {
      const batch = state.batches.get(id);
      let kind = 'clean-descendants';
      if (batch.children.length === 0) kind = 'sink';
      else if (batch.scrapped) kind = 'tombstone';
      return { batch: id, kind };
    });
  return {
    rules_version: RULES_VERSION,
    input_hash: hashEvents(state.events),
    sources,
    affected_batches: affected,
    affected_products: products,
    boundary,
    corrections: state.events
      .filter((event) => event.type === 'correct')
      .map((event) => ({ inspection: event.inspection, status: event.status })),
    tombstones: [...state.batches.values()].filter((b) => b.scrapped).map((b) => b.id).sort(),
  };
}

function verifyCertificate(state, certificate) {
  const expected = buildCertificate(state);
  const mismatches = [];
  for (const key of Object.keys(expected)) {
    if (JSON.stringify(expected[key]) !== JSON.stringify(certificate[key])) {
      mismatches.push(key);
    }
  }
  return { ok: mismatches.length === 0, mismatches, expected };
}

function serializeState(state) {
  return { format: STATE_FORMAT, rules_version: RULES_VERSION, events: state.events };
}

function deserializeState(data) {
  if (!data || !Array.isArray(data.events)) {
    throw new TraceError('state file is missing the events array', EXIT_ERROR);
  }
  return buildState(data.events);
}

module.exports = {
  RULES_VERSION,
  EXIT_ERROR,
  EXIT_CYCLE,
  EXIT_DANGLING,
  TraceError,
  canonicalEvent,
  hashEvents,
  parseJsonl,
  normalizeStatus,
  effectiveStatus,
  buildState,
  appendEvents,
  computeContamination,
  downstreamClosure,
  correctInspection,
  buildCertificate,
  verifyCertificate,
  serializeState,
  deserializeState,
};
