export const MAX_STRATEGIES = 20;
export const MAX_SAMPLES = 30;

export class InputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InputError";
  }
}

export interface Strategy {
  id: string;
  /** Raw output values, aligned with `sampleIds` order. */
  outputs: unknown[];
  /** Canonical string form of each output, used for equality. */
  canonical: string[];
}

export interface Problem {
  sampleIds: string[];
  strategies: Strategy[];
}

/** Deterministic serialization so any JSON values compare structurally. */
export function canonicalize(value: unknown): string {
  if (value === undefined) {
    throw new InputError("output values must be JSON values (found undefined)");
  }
  if (value === null || typeof value === "number" || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map((item) => canonicalize(item)).join(",") + "]";
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return "{" + keys.map((key) => JSON.stringify(key) + ":" + canonicalize(record[key])).join(",") + "}";
  }
  throw new InputError(`unsupported output value of type ${typeof value}`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireId(value: unknown, what: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new InputError(`${what} must be a non-empty string`);
  }
  return value;
}

function normalizeOutputs(
  raw: unknown,
  sampleIds: string[],
  strategyId: string
): unknown[] {
  if (Array.isArray(raw)) {
    if (raw.length !== sampleIds.length) {
      throw new InputError(
        `strategy "${strategyId}": outputs array has ${raw.length} entries, expected ${sampleIds.length} (one per sample)`
      );
    }
    return raw.slice();
  }
  if (isPlainObject(raw)) {
    const outputs: unknown[] = [];
    for (const sampleId of sampleIds) {
      if (!(sampleId in raw)) {
        throw new InputError(`strategy "${strategyId}": missing output for sample "${sampleId}"`);
      }
      outputs.push(raw[sampleId]);
    }
    const extra = Object.keys(raw).filter((key) => !sampleIds.includes(key));
    if (extra.length > 0) {
      throw new InputError(
        `strategy "${strategyId}": outputs reference unknown samples: ${extra.join(", ")}`
      );
    }
    return outputs;
  }
  throw new InputError(`strategy "${strategyId}": outputs must be an array or an object keyed by sample id`);
}

export function parseProblem(raw: unknown): Problem {
  if (!isPlainObject(raw)) {
    throw new InputError("input must be a JSON object with \"samples\" and \"strategies\"");
  }
  const { samples, strategies } = raw as { samples?: unknown; strategies?: unknown };

  if (!Array.isArray(samples)) {
    throw new InputError("\"samples\" must be an array of sample id strings");
  }
  if (samples.length === 0) {
    throw new InputError("at least one sample is required");
  }
  if (samples.length > MAX_SAMPLES) {
    throw new InputError(`at most ${MAX_SAMPLES} samples are supported (got ${samples.length})`);
  }
  const sampleIds = samples.map((entry, index) => requireId(entry, `samples[${index}]`));
  if (new Set(sampleIds).size !== sampleIds.length) {
    throw new InputError("sample ids must be unique");
  }

  if (!Array.isArray(strategies)) {
    throw new InputError("\"strategies\" must be an array of {id, outputs}");
  }
  if (strategies.length === 0) {
    throw new InputError("at least one strategy is required");
  }
  if (strategies.length > MAX_STRATEGIES) {
    throw new InputError(`at most ${MAX_STRATEGIES} strategies are supported (got ${strategies.length})`);
  }

  const seen = new Set<string>();
  const parsed: Strategy[] = strategies.map((entry, index) => {
    if (!isPlainObject(entry)) {
      throw new InputError(`strategies[${index}] must be an object with "id" and "outputs"`);
    }
    const id = requireId(entry.id, `strategies[${index}].id`);
    if (seen.has(id)) {
      throw new InputError(`duplicate strategy id "${id}"`);
    }
    seen.add(id);
    const outputs = normalizeOutputs(entry.outputs, sampleIds, id);
    return { id, outputs, canonical: outputs.map((value) => canonicalize(value)) };
  });

  return { sampleIds, strategies: parsed };
}
