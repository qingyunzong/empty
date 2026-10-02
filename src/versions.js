import { TemplateError, ErrorCode } from './errors.js';
import { normalizedHash } from './hash.js';

const clone = (value) => structuredClone(value);

function deepFreeze(value) {
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
    Object.freeze(value);
  }
  return value;
}

function normalizePatch(patch) {
  const ops = Array.isArray(patch) ? patch : patch && Array.isArray(patch.ops) ? patch.ops : [patch];
  if (ops.length === 0) {
    throw new TemplateError(ErrorCode.INVALID_PATCH, 'patch contains no operations');
  }
  for (const op of ops) {
    if (!op || typeof op !== 'object') {
      throw new TemplateError(ErrorCode.INVALID_PATCH, 'patch operation must be an object');
    }
    if (op.op === 'set') {
      if (typeof op.name !== 'string' || op.name === '') {
        throw new TemplateError(ErrorCode.INVALID_PATCH, '"set" operation requires a non-empty "name"');
      }
    } else if (op.op === 'delete') {
      if (typeof op.name !== 'string' || op.name === '') {
        throw new TemplateError(ErrorCode.INVALID_PATCH, '"delete" operation requires a non-empty "name"');
      }
    } else if (op.op === 'template') {
      if (typeof op.value !== 'string') {
        throw new TemplateError(ErrorCode.INVALID_PATCH, '"template" operation requires a string "value"');
      }
    } else {
      throw new TemplateError(ErrorCode.INVALID_PATCH, `unknown patch operation "${op.op}"`);
    }
  }
  return ops;
}

export class VersionStore {
  #versions = [];
  #index = 0;

  constructor(template, variables = {}) {
    this.#versions.push(deepFreeze(clone({ template, variables })));
  }

  get version() {
    return this.#index;
  }

  get length() {
    return this.#versions.length;
  }

  current() {
    return this.#versions[this.#index];
  }

  stateHash() {
    return normalizedHash(this.current());
  }

  applyPatch(patch) {
    const ops = normalizePatch(patch);
    const next = clone(this.current());
    for (const op of ops) {
      if (op.op === 'set') next.variables[op.name] = clone(op.value);
      else if (op.op === 'delete') delete next.variables[op.name];
      else if (op.op === 'template') next.template = op.value;
    }
    this.#versions.length = this.#index + 1;
    this.#versions.push(deepFreeze(next));
    this.#index++;
    return this.#index;
  }

  undo() {
    if (this.#index > 0) this.#index--;
    return this.#index;
  }

  redo() {
    if (this.#index < this.#versions.length - 1) this.#index++;
    return this.#index;
  }
}
