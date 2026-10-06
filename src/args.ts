/** Layered argument library: merges defaults, config and CLI argv. */

export type Source = "default" | "config" | "cli";

export type Location =
  | { kind: "cli"; index: number; token: string }
  | { kind: "config"; key: string }
  | { kind: "default" };

export interface Origin {
  source: Source;
  location: Location;
}

export type OptionType = "string" | "number" | "boolean" | "list";

export interface OptionSpec {
  name: string;
  short?: string;
  type: OptionType;
  /** Scalar default, or string[] for type "list". Counts as the "default" layer. */
  default?: unknown;
  description?: string;
}

export interface MutexGroup {
  name: string;
  options: string[];
}

export interface Schema {
  options: OptionSpec[];
  mutexGroups?: MutexGroup[];
}

export type Value = string | number | boolean | string[];

export interface ParseResult {
  values: Record<string, Value>;
  /** Where each final value came from. */
  sources: Record<string, Origin>;
  /** Bare tokens and everything after `--`. */
  positionals: string[];
}

export interface ConflictEntry {
  option: string;
  origin: Origin;
}

export class ArgsError extends Error {
  readonly location?: Location;
  /** For mutex violations: every conflicting option with its origin. */
  readonly conflicts?: ConflictEntry[];

  constructor(message: string, opts?: { location?: Location; conflicts?: ConflictEntry[] }) {
    super(message);
    this.name = "ArgsError";
    if (opts?.location !== undefined) this.location = opts.location;
    if (opts?.conflicts !== undefined) this.conflicts = opts.conflicts;
  }
}

export function formatLocation(loc: Location): string {
  switch (loc.kind) {
    case "cli":
      return `argv[${loc.index}] ('${loc.token}')`;
    case "config":
      return `config key '${loc.key}'`;
    case "default":
      return "schema default";
  }
}

interface Occurrence {
  value: Value;
  location: Location;
}

interface Layer {
  source: Source;
  occurrences: Occurrence[];
}

const LAYER_ORDER: Source[] = ["default", "config", "cli"];

export function parse(schema: Schema, config: Record<string, unknown> = {}, argv: string[] = []): ParseResult {
  const byName = new Map<string, OptionSpec>();
  const byShort = new Map<string, OptionSpec>();
  for (const spec of schema.options) {
    if (byName.has(spec.name)) throw new ArgsError(`duplicate option '${spec.name}' in schema`);
    byName.set(spec.name, spec);
    if (spec.short !== undefined) {
      if (byShort.has(spec.short)) throw new ArgsError(`duplicate short option '-${spec.short}' in schema`);
      byShort.set(spec.short, spec);
    }
  }

  const layers = new Map<string, Layer[]>();
  for (const spec of schema.options) {
    layers.set(spec.name, LAYER_ORDER.map((source) => ({ source, occurrences: [] })));
  }

  const push = (name: string, source: Source, value: Value, location: Location): void => {
    const stack = layers.get(name);
    if (!stack) throw new ArgsError(`unknown option '${name}'`, { location });
    const layer = stack[LAYER_ORDER.indexOf(source)];
    if (!layer) throw new ArgsError(`internal: bad layer '${source}'`);
    layer.occurrences.push({ value, location });
  };

  // --- default layer -------------------------------------------------------
  for (const spec of schema.options) {
    if (spec.default === undefined) continue;
    const location: Location = { kind: "default" };
    if (spec.type === "list") {
      if (!Array.isArray(spec.default) || spec.default.some((v) => typeof v !== "string")) {
        throw new ArgsError(`default for list option '--${spec.name}' must be a string array`, { location });
      }
      for (const item of spec.default) push(spec.name, "default", item, location);
    } else {
      push(spec.name, "default", coerce(spec, spec.default, location), location);
    }
  }

  // --- config layer --------------------------------------------------------
  for (const [key, raw] of Object.entries(config)) {
    const spec = byName.get(key);
    const location: Location = { kind: "config", key };
    if (!spec) throw new ArgsError(`unknown option '${key}' in config`, { location });
    if (spec.type === "list") {
      if (!Array.isArray(raw) || raw.some((v) => typeof v !== "string")) {
        throw new ArgsError(`config value for list option '--${key}' must be a string array`, { location });
      }
      for (const item of raw) push(key, "config", item, location);
    } else {
      push(key, "config", coerce(spec, raw, location), location);
    }
  }

  // --- cli layer -----------------------------------------------------------
  const positionals: string[] = [];
  let optionsEnded = false;
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] as string;
    if (optionsEnded) {
      positionals.push(token);
      continue;
    }
    if (token === "--") {
      optionsEnded = true;
      continue;
    }
    if (token.startsWith("--")) {
      const eq = token.indexOf("=");
      const rawName = eq === -1 ? token.slice(2) : token.slice(2, eq);
      const inlineValue = eq === -1 ? undefined : token.slice(eq + 1);
      const negated = rawName.startsWith("no-");
      const name = negated ? rawName.slice(3) : rawName;
      const spec = byName.get(name);
      const location: Location = { kind: "cli", index: i, token };
      if (!spec) throw new ArgsError(`unknown option '--${rawName}'`, { location });
      if (negated) {
        if (spec.type !== "boolean") {
          throw new ArgsError(`'--no-${name}' is only valid for boolean options`, { location });
        }
        if (inlineValue !== undefined) {
          throw new ArgsError(`'--no-${name}' does not take a value`, { location });
        }
        push(name, "cli", false, location);
        continue;
      }
      i = consume(spec, inlineValue, argv, i, (value, loc) => push(spec.name, "cli", value, loc));
      continue;
    }
    if (token.startsWith("-") && token.length > 1) {
      const eq = token.indexOf("=");
      const short = eq === -1 ? token.slice(1) : token.slice(1, eq);
      const inlineValue = eq === -1 ? undefined : token.slice(eq + 1);
      const spec = byShort.get(short);
      const location: Location = { kind: "cli", index: i, token };
      if (!spec) throw new ArgsError(`unknown option '-${short}'`, { location });
      i = consume(spec, inlineValue, argv, i, (value, loc) => push(spec.name, "cli", value, loc));
      continue;
    }
    positionals.push(token);
  }

  // --- merge ---------------------------------------------------------------
  const values: Record<string, Value> = {};
  const sources: Record<string, Origin> = {};
  for (const spec of schema.options) {
    const stack = layers.get(spec.name) as Layer[];
    // Highest layer with at least one occurrence wins.
    let winner: Layer | undefined;
    for (let i = stack.length - 1; i >= 0; i--) {
      const layer = stack[i] as Layer;
      if (layer.occurrences.length > 0) {
        winner = layer;
        break;
      }
    }
    if (!winner) continue; // option not set anywhere: absent from values
    if (spec.type === "list") {
      // Same layer accumulates; the winning layer replaces lower layers.
      values[spec.name] = winner.occurrences.map((o) => o.value as string);
      const last = winner.occurrences[winner.occurrences.length - 1] as Occurrence;
      sources[spec.name] = { source: winner.source, location: last.location };
    } else {
      // Last occurrence of the highest layer wins.
      const last = winner.occurrences[winner.occurrences.length - 1] as Occurrence;
      values[spec.name] = last.value;
      sources[spec.name] = { source: winner.source, location: last.location };
    }
  }

  // --- mutex groups, checked against final merged values -------------------
  for (const group of schema.mutexGroups ?? []) {
    const set = group.options.filter((name) => {
      const origin = sources[name];
      return origin !== undefined && origin.source !== "default";
    });
    if (set.length > 1) {
      const conflicts: ConflictEntry[] = set.map((option) => ({
        option,
        origin: sources[option] as Origin,
      }));
      const detail = conflicts
        .map((c) => `--${c.option} (from ${c.origin.source}, ${formatLocation(c.origin.location)})`)
        .join(" and ");
      throw new ArgsError(`mutually exclusive options in group '${group.name}': ${detail}`, { conflicts });
    }
  }

  return { values, sources, positionals };
}

/** Consume a value for `spec` at argv[i]; returns the new index. */
function consume(
  spec: OptionSpec,
  inlineValue: string | undefined,
  argv: string[],
  i: number,
  emit: (value: Value, location: Location) => void,
): number {
  const location: Location = { kind: "cli", index: i, token: argv[i] as string };
  if (spec.type === "boolean") {
    if (inlineValue !== undefined) {
      throw new ArgsError(`boolean option '--${spec.name}' does not take a value`, { location });
    }
    emit(true, location);
    return i;
  }
  let raw: string;
  let valueLocation = location;
  if (inlineValue !== undefined) {
    raw = inlineValue;
  } else {
    const next = argv[i + 1];
    if (next === undefined) {
      throw new ArgsError(`option '--${spec.name}' requires a value`, { location });
    }
    raw = next;
    valueLocation = { kind: "cli", index: i + 1, token: next };
    i += 1;
  }
  // Errors point at the offending value; the recorded origin points at the flag.
  emit(coerce(spec, raw, valueLocation), location);
  return i;
}

function coerce(spec: OptionSpec, raw: unknown, location: Location): Value {
  switch (spec.type) {
    case "string":
      if (typeof raw !== "string") {
        throw new ArgsError(`option '--${spec.name}' expects a string, got ${JSON.stringify(raw)}`, { location });
      }
      return raw;
    case "boolean":
      if (typeof raw !== "boolean") {
        throw new ArgsError(`option '--${spec.name}' expects a boolean, got ${JSON.stringify(raw)}`, { location });
      }
      return raw;
    case "number": {
      const n = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN;
      if (Number.isNaN(n)) {
        throw new ArgsError(`option '--${spec.name}' expects a number, got ${JSON.stringify(raw)}`, { location });
      }
      return n;
    }
    case "list":
      if (typeof raw !== "string") {
        throw new ArgsError(`list option '--${spec.name}' expects string items, got ${JSON.stringify(raw)}`, {
          location,
        });
      }
      return raw;
  }
}
