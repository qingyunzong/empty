import { createHash } from 'node:crypto';

export const RULE_VERSION = '1.0.0';

export const EXIT = Object.freeze({
  OK: 0,
  MISMATCH: 1,
  PARSE: 2,
  CYCLE: 6,
  MISSING_REF: 7,
});

export class TraceError extends Error {
  constructor(exitCode, message) {
    super(message);
    this.name = 'TraceError';
    this.exitCode = exitCode;
  }
}

export function canonicalize(value) {
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalize).join(',') + ']';
  }
  if (value !== null && typeof value === 'object') {
    return '{' + Object.keys(value).sort()
      .map((k) => JSON.stringify(k) + ':' + canonicalize(value[k]))
      .join(',') + '}';
  }
  return JSON.stringify(value);
}

export function hashEvents(events) {
  const hash = createHash('sha256');
  for (const event of events) hash.update(canonicalize(event) + '\n');
  return 'sha256:' + hash.digest('hex');
}

export function normalizeStatus(status) {
  return status === 'pass' || status === 'fail' ? status : 'unknown';
}

export function parseJsonl(text) {
  const events = [];
  const lines = String(text).split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue;
    let event;
    try {
      event = JSON.parse(trimmed);
    } catch {
      throw new TraceError(EXIT.PARSE, `line ${i + 1}: invalid JSON`);
    }
    if (event === null || typeof event !== 'object' || Array.isArray(event)) {
      throw new TraceError(EXIT.PARSE, `line ${i + 1}: event must be a JSON object`);
    }
    events.push(event);
  }
  return events;
}

export function createState() {
  return {
    ruleVersion: RULE_VERSION,
    events: [],
    batches: {},
    order: [],
    contaminated: {},
    sources: [],
  };
}

function defineBatch(state, id, kind) {
  if (typeof id !== 'string' || id.length === 0) {
    throw new TraceError(EXIT.PARSE, `invalid batch id in ${kind} event`);
  }
  if (state.batches[id]) {
    throw new TraceError(EXIT.MISSING_REF, `duplicate batch definition: ${id}`);
  }
  state.batches[id] = {
    id,
    kind,
    parents: [],
    children: [],
    inspections: [],
    scrappedAt: null,
  };
  state.order.push(id);
}

function requireBatch(state, id) {
  if (typeof id !== 'string' || !state.batches[id]) {
    throw new TraceError(EXIT.MISSING_REF, `reference to unknown batch: ${String(id)}`);
  }
  return state.batches[id];
}

function requireStringArray(value, what) {
  if (!Array.isArray(value) || value.length === 0 || value.some((v) => typeof v !== 'string')) {
    throw new TraceError(EXIT.PARSE, `${what} must be a non-empty array of batch ids`);
  }
  return value;
}

function link(state, from, to, seq) {
  state.batches[from].children.push(to);
  state.batches[to].parents.push({ id: from, seq });
}

function transmits(state, edge) {
  const cut = state.batches[edge.id].scrappedAt;
  return cut === null || edge.seq <= cut;
}

function applyEvent(state, event) {
  const seq = state.events.length;
  switch (event.type) {
    case 'charge': {
      defineBatch(state, event.batch, 'charge');
      break;
    }
    case 'mix': {
      const inputs = requireStringArray(event.inputs, 'mix.inputs');
      for (const input of inputs) requireBatch(state, input);
      defineBatch(state, event.output, 'mix');
      for (const input of inputs) link(state, input, event.output, seq);
      break;
    }
    case 'split': {
      requireBatch(state, event.input);
      const outputs = requireStringArray(event.outputs, 'split.outputs');
      for (const output of outputs) defineBatch(state, output, 'split');
      for (const output of outputs) link(state, event.input, output, seq);
      break;
    }
    case 'link': {
      requireBatch(state, event.from);
      requireBatch(state, event.to);
      link(state, event.from, event.to, seq);
      break;
    }
    case 'inspect': {
      const batch = requireBatch(state, event.batch);
      const id = event.id ?? `I${state.events.length + 1}`;
      if (event.corrects !== undefined &&
          !batch.inspections.some((insp) => insp.id === event.corrects)) {
        throw new TraceError(EXIT.MISSING_REF,
          `corrects unknown inspection ${String(event.corrects)} on batch ${event.batch}`);
      }
      batch.inspections.push({
        id,
        batch: event.batch,
        status: normalizeStatus(event.status),
        raw: event.status,
        corrects: event.corrects ?? null,
      });
      break;
    }
    case 'scrap': {
      const batch = requireBatch(state, event.batch);
      if (batch.scrappedAt === null) batch.scrappedAt = seq;
      break;
    }
    default:
      throw new TraceError(EXIT.PARSE, `unknown event type: ${String(event.type)}`);
  }
}

function topoOrder(state) {
  const indegree = new Map();
  for (const id of state.order) indegree.set(id, state.batches[id].parents.length);
  const queue = state.order.filter((id) => indegree.get(id) === 0);
  const order = [];
  while (queue.length > 0) {
    const id = queue.shift();
    order.push(id);
    for (const child of state.batches[id].children) {
      indegree.set(child, indegree.get(child) - 1);
      if (indegree.get(child) === 0) queue.push(child);
    }
  }
  if (order.length !== state.order.length) {
    const remaining = state.order.filter((id) => !order.includes(id));
    throw new TraceError(EXIT.CYCLE, `cycle detected involving: ${remaining.join(', ')}`);
  }
  return order;
}

function computeNode(state, id) {
  const batch = state.batches[id];
  const last = batch.inspections[batch.inspections.length - 1];
  if (last && last.status === 'fail') return true;
  return batch.parents.some(
    (edge) => transmits(state, edge) && state.contaminated[edge.id],
  );
}

function computeSources(state) {
  const sources = state.order.filter((id) => {
    if (!state.contaminated[id]) return false;
    return !state.batches[id].parents
      .some((edge) => transmits(state, edge) && state.contaminated[edge.id]);
  });
  sources.sort();
  return sources;
}

function recomputeAll(state) {
  for (const id of topoOrder(state)) {
    state.contaminated[id] = computeNode(state, id);
  }
  state.sources = computeSources(state);
}

export function applyEvents(state, events) {
  for (const event of events) {
    applyEvent(state, event);
    state.events.push(event);
  }
  recomputeAll(state);
  return state;
}

export function buildState(events) {
  return applyEvents(createState(), events);
}

export function descendantsOf(state, id) {
  const seen = new Set([id]);
  const stack = [id];
  while (stack.length > 0) {
    for (const child of state.batches[stack.pop()].children) {
      if (!seen.has(child)) {
        seen.add(child);
        stack.push(child);
      }
    }
  }
  return seen;
}

export function correctInspection(state, { id, batch, status, corrects }) {
  const target = requireBatch(state, batch);
  const event = { type: 'inspect', id: id ?? `C${state.events.length + 1}`, batch, status };
  if (corrects !== undefined) event.corrects = corrects;
  applyEvent(state, event);
  state.events.push(event);

  const before = { ...state.contaminated };
  const closure = descendantsOf(state, batch);
  for (const node of topoOrder(state)) {
    if (closure.has(node)) state.contaminated[node] = computeNode(state, node);
  }
  state.sources = computeSources(state);

  const changed = state.order.filter((node) => state.contaminated[node] !== before[node]);
  return { changed, closure, event, batch: target.id };
}

export function affectedProducts(state) {
  return state.order
    .filter((id) => state.contaminated[id] && state.batches[id].children.length === 0)
    .sort();
}

export function recallCertificate(state) {
  return {
    ruleVersion: state.ruleVersion,
    inputHash: hashEvents(state.events),
    boundary: {
      sources: [...state.sources],
      affectedProducts: affectedProducts(state),
    },
    contaminated: state.order.filter((id) => state.contaminated[id]).sort(),
    scrapped: state.order.filter((id) => state.batches[id].scrappedAt !== null).sort(),
  };
}

export function verifyCertificate(events, certificate) {
  const replayed = recallCertificate(buildState(events));
  const fields = ['ruleVersion', 'inputHash', 'boundary', 'contaminated', 'scrapped'];
  const mismatches = fields.filter(
    (field) => canonicalize(replayed[field]) !== canonicalize(certificate[field]),
  );
  return { ok: mismatches.length === 0, mismatches, replayed };
}
