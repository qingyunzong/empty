export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface SampleSpec {
  id: string;
}

export interface StrategySpec {
  id: string;
  /** Output of this strategy for each candidate sample, aligned with `samples`. */
  outputs: JsonValue[];
}

export interface ProblemSpec {
  samples: SampleSpec[];
  strategies: StrategySpec[];
}

export const MAX_STRATEGIES = 20;
export const MAX_SAMPLES = 30;

/** Stable serialization used for deep equality of strategy outputs. */
export function canonical(value: JsonValue): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map(canonical).join(",") + "]";
  }
  const keys = Object.keys(value).sort();
  return (
    "{" +
    keys.map((k) => JSON.stringify(k) + ":" + canonical(value[k])).join(",") +
    "}"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readId(value: unknown, what: string): string {
  if (!isRecord(value) || typeof value.id !== "string" || value.id.length === 0) {
    throw new Error(`${what} must be an object with a non-empty string "id"`);
  }
  return value.id;
}

function assertUnique(ids: string[], what: string): void {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) {
      throw new Error(`duplicate ${what} id: ${JSON.stringify(id)}`);
    }
    seen.add(id);
  }
}

/** Validate untrusted JSON input and normalize it into a ProblemSpec. */
export function parseProblem(raw: unknown): ProblemSpec {
  if (!isRecord(raw)) {
    throw new Error("input must be a JSON object with \"samples\" and \"strategies\"");
  }
  if (!Array.isArray(raw.samples) || raw.samples.length === 0) {
    throw new Error("\"samples\" must be a non-empty array");
  }
  if (!Array.isArray(raw.strategies) || raw.strategies.length === 0) {
    throw new Error("\"strategies\" must be a non-empty array");
  }
  if (raw.samples.length > MAX_SAMPLES) {
    throw new Error(
      `too many samples: ${raw.samples.length} (maximum ${MAX_SAMPLES})`
    );
  }
  if (raw.strategies.length > MAX_STRATEGIES) {
    throw new Error(
      `too many strategies: ${raw.strategies.length} (maximum ${MAX_STRATEGIES})`
    );
  }

  const samples: SampleSpec[] = raw.samples.map((s, i) => ({
    id: readId(s, `samples[${i}]`),
  }));
  assertUnique(samples.map((s) => s.id), "sample");

  const sampleCount = samples.length;
  const strategies: StrategySpec[] = raw.strategies.map((s, i) => {
    const id = readId(s, `strategies[${i}]`);
    const outputs = (s as Record<string, unknown>).outputs;
    if (!Array.isArray(outputs)) {
      throw new Error(`strategy ${JSON.stringify(id)} must have an "outputs" array`);
    }
    if (outputs.length !== sampleCount) {
      throw new Error(
        `strategy ${JSON.stringify(id)} has ${outputs.length} outputs, ` +
          `expected ${sampleCount} (one per sample)`
      );
    }
    return { id, outputs: outputs as JsonValue[] };
  });
  assertUnique(strategies.map((s) => s.id), "strategy");

  return { samples, strategies };
}
