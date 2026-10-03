export const DOMAIN_EXIT_CODE = 4;

export class TraceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = code;
    this.code = code;
  }
}

export class CyclicLineageError extends TraceError {
  constructor(message) {
    super('CYCLIC_LINEAGE', message);
  }
}

export class UnknownParentError extends TraceError {
  constructor(message) {
    super('UNKNOWN_PARENT', message);
  }
}

export class LayerHoleError extends TraceError {
  constructor(message) {
    super('LAYER_HOLE', message);
  }
}

export class ValidationError extends TraceError {
  constructor(message) {
    super('VALIDATION', message);
  }
}
