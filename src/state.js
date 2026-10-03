export class ManifestError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ManifestError';
    this.code = code;
  }
}

export const DEFAULT_BUILDERS = ['concat', 'normalize', 'aggregate', 'annotate'];

export function initialState() {
  return { files: new Map(), artifacts: new Map(), releases: new Map() };
}

export function cloneState(state) {
  return structuredClone(state);
}

function requireId(op) {
  if (typeof op.id !== 'string' || op.id.length === 0) {
    throw new ManifestError('E_OP', `operation '${op.op}' requires a non-empty string id`);
  }
  return op.id;
}

function nodeExists(state, id) {
  return state.files.has(id) || state.artifacts.has(id) || state.releases.has(id);
}

function inputExists(state, id) {
  return state.files.has(id) || state.artifacts.has(id);
}

function ensureNew(state, id) {
  if (nodeExists(state, id)) {
    throw new ManifestError('E_DUP', `node '${id}' already exists`);
  }
}

function validateInputs(state, inputs) {
  if (!Array.isArray(inputs)) throw new ManifestError('E_OP', 'inputs must be an array of node ids');
  for (const inp of inputs) {
    if (typeof inp !== 'string') throw new ManifestError('E_OP', 'input ids must be strings');
    if (!inputExists(state, inp)) {
      throw new ManifestError('E_NODE', `input '${inp}' does not name a file or artifact`);
    }
  }
  return [...new Set(inputs)];
}

function edgeTarget(state, from) {
  if (state.artifacts.has(from)) return state.artifacts.get(from);
  if (state.releases.has(from)) return state.releases.get(from);
  throw new ManifestError('E_NODE', `'${from}' does not name an artifact or release`);
}

export function applyOps(state, ops) {
  for (const op of ops) {
    if (!op || typeof op.op !== 'string') throw new ManifestError('E_OP', 'operation missing op field');
    switch (op.op) {
      case 'putFile': {
        const id = requireId(op);
        if (state.artifacts.has(id) || state.releases.has(id)) {
          throw new ManifestError('E_DUP', `node '${id}' already exists as a non-file node`);
        }
        state.files.set(id, { content: String(op.content ?? '') });
        break;
      }
      case 'addArtifact': {
        const id = requireId(op);
        ensureNew(state, id);
        if (typeof op.builder !== 'string' || op.builder.length === 0) {
          throw new ManifestError('E_OP', `artifact '${id}' requires a builder name`);
        }
        state.artifacts.set(id, { builder: op.builder, inputs: validateInputs(state, op.inputs ?? []) });
        break;
      }
      case 'removeArtifact': {
        const id = requireId(op);
        if (!state.artifacts.has(id)) throw new ManifestError('E_NODE', `artifact '${id}' does not exist`);
        state.artifacts.delete(id);
        break;
      }
      case 'addRelease': {
        const id = requireId(op);
        ensureNew(state, id);
        state.releases.set(id, { inputs: validateInputs(state, op.inputs ?? []) });
        break;
      }
      case 'removeRelease': {
        const id = requireId(op);
        if (!state.releases.has(id)) throw new ManifestError('E_NODE', `release '${id}' does not exist`);
        state.releases.delete(id);
        break;
      }
      case 'addEdge': {
        const target = edgeTarget(state, requireId({ id: op.from, op: op.op }));
        if (!inputExists(state, op.to)) {
          throw new ManifestError('E_NODE', `edge target '${op.to}' does not name a file or artifact`);
        }
        if (target.inputs.includes(op.to)) {
          throw new ManifestError('E_EDGE', `edge ${op.from} -> ${op.to} already exists`);
        }
        target.inputs.push(op.to);
        break;
      }
      case 'removeEdge': {
        const target = edgeTarget(state, requireId({ id: op.from, op: op.op }));
        const idx = target.inputs.indexOf(op.to);
        if (idx === -1) throw new ManifestError('E_EDGE', `edge ${op.from} -> ${op.to} does not exist`);
        target.inputs.splice(idx, 1);
        break;
      }
      default:
        throw new ManifestError('E_OP', `unknown operation '${op.op}'`);
    }
  }
  return state;
}
