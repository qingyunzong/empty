/**
 * Layered parameter resolution.
 *
 * Layers (lowest to highest priority): default < config < cli.
 *  - Single-value options: the highest layer wins; within one layer the last
 *    occurrence wins.
 *  - List options: occurrences accumulate within the same layer; any
 *    occurrence in a higher layer replaces the lower layer's list entirely.
 *  - `--` on the command line terminates option parsing; the remaining
 *    tokens are returned as positionals.
 *  - Mutex groups are validated against the final merged values: a member
 *    counts as "set" when its final value comes from config or cli (a plain
 *    default never triggers a conflict).
 * Every final value carries its provenance (layer + position), and every
 * error reports the position of the offending argument.
 */

export type Layer = "default" | "config" | "cli";

export const LAYER_RANK: Record<Layer, number> = { default: 0, config: 1, cli: 2 };

export interface SourceRef {
  layer: Layer;
  /** Human-readable position, e.g. "argv[3]", "config.format", "default". */
  position: string;
}

export type OptionType = "boolean" | "string" | "number" | "list";

export interface OptionSpec {
  name: string;
  short?: string;
  type: OptionType;
  description?: string;
  /** Default value; lists default to string[]. */
  default?: boolean | string | number | string[];
}

export interface ParamError {
  message: string;
  /** Where the offending argument came from; null for spec-level problems. */
  source: SourceRef | null;
}

export interface ResolveInput {
  specs: OptionSpec[];
  /** Parsed config-file object (already loaded JSON/YAML). */
  config?: Record<string, unknown>;
  /** CLI tokens, typically process.argv.slice(2). */
  argv?: string[];
  /** Groups of option names that must not be set together. */
  mutexGroups?: string[][];
}

export interface Resolved {
  /** Final merged values (only options with a value are present). */
  values: Record<string, unknown>;
  /** Provenance of each final value. */
  sources: Record<string, SourceRef>;
  /** Tokens after `--` plus non-option tokens. */
  positionals: string[];
  errors: ParamError[];
}

interface Occurrence {
  value: unknown;
  ref: SourceRef;
}

function formatRef(ref: SourceRef): string {
  return `${ref.layer} ${ref.position}`;
}

/** Parse CLI tokens into per-option occurrences. Exported for reuse/testing. */
export function parseArgv(
  specs: OptionSpec[],
  argv: string[],
): { occurrences: Map<string, Occurrence[]>; positionals: string[]; errors: ParamError[] } {
  const byName = new Map<string, OptionSpec>();
  const byShort = new Map<string, OptionSpec>();
  for (const spec of specs) {
    byName.set(spec.name, spec);
    if (spec.short !== undefined) byShort.set(spec.short, spec);
  }

  const occurrences = new Map<string, Occurrence[]>();
  const positionals: string[] = [];
  const errors: ParamError[] = [];

  const push = (spec: OptionSpec, value: unknown, index: number): void => {
    const ref: SourceRef = { layer: "cli", position: `argv[${index}]` };
    if (spec.type === "number" && typeof value === "string") {
      const parsed = Number(value);
      if (value.trim() === "" || Number.isNaN(parsed)) {
        errors.push({
          message: `option --${spec.name}: invalid number "${value}"`,
          source: ref,
        });
        return;
      }
      value = parsed;
    }
    const list = occurrences.get(spec.name);
    const occ: Occurrence = { value, ref };
    if (list) list.push(occ);
    else occurrences.set(spec.name, [occ]);
  };

  /** True when token looks like another option rather than a value. */
  const looksLikeOption = (token: string): boolean =>
    token.startsWith("--") || /^-[a-zA-Z]$/.test(token);

  let index = 0;
  let optionsEnded = false;
  while (index < argv.length) {
    const token = argv[index] as string;
    if (optionsEnded) {
      positionals.push(token);
      index += 1;
      continue;
    }
    if (token === "--") {
      optionsEnded = true;
      index += 1;
      continue;
    }
    if (token.startsWith("--")) {
      const body = token.slice(2);
      const eq = body.indexOf("=");
      const name = eq === -1 ? body : body.slice(0, eq);
      const inlineValue = eq === -1 ? undefined : body.slice(eq + 1);

      if (name.startsWith("no-")) {
        const spec = byName.get(name.slice(3));
        if (spec && spec.type === "boolean" && inlineValue === undefined) {
          push(spec, false, index);
          index += 1;
          continue;
        }
      }

      const spec = byName.get(name);
      if (!spec) {
        errors.push({
          message: `unknown option --${name}`,
          source: { layer: "cli", position: `argv[${index}]` },
        });
        index += 1;
        continue;
      }
      if (spec.type === "boolean") {
        if (inlineValue === undefined) {
          push(spec, true, index);
        } else if (inlineValue === "true" || inlineValue === "false") {
          push(spec, inlineValue === "true", index);
        } else {
          errors.push({
            message: `option --${spec.name}: invalid boolean "${inlineValue}"`,
            source: { layer: "cli", position: `argv[${index}]` },
          });
        }
        index += 1;
        continue;
      }
      if (inlineValue !== undefined) {
        push(spec, inlineValue, index);
        index += 1;
        continue;
      }
      const next = argv[index + 1];
      if (next === undefined || looksLikeOption(next)) {
        errors.push({
          message: `option --${spec.name}: missing value`,
          source: { layer: "cli", position: `argv[${index}]` },
        });
        index += 1;
        continue;
      }
      push(spec, next, index + 1);
      index += 2;
      continue;
    }
    if (token.length > 1 && token.startsWith("-") && token !== "-") {
      const chars = token.slice(1);
      let consumed = 0;
      let ok = true;
      for (let pos = 0; pos < chars.length; pos += 1) {
        const spec = byShort.get(chars[pos] as string);
        if (!spec) {
          errors.push({
            message: `unknown option -${chars[pos]}`,
            source: { layer: "cli", position: `argv[${index}]` },
          });
          ok = false;
          break;
        }
        if (spec.type === "boolean") {
          push(spec, true, index);
          continue;
        }
        // Value-taking short option: rest of token or next token is the value.
        const rest = chars.slice(pos + 1);
        if (rest !== "") {
          push(spec, rest.startsWith("=") ? rest.slice(1) : rest, index);
        } else {
          const next = argv[index + 1];
          if (next === undefined || looksLikeOption(next)) {
            errors.push({
              message: `option -${spec.short}: missing value`,
              source: { layer: "cli", position: `argv[${index}]` },
            });
            ok = false;
            break;
          }
          push(spec, next, index + 1);
          consumed = 1;
        }
        break;
      }
      index += 1 + consumed;
      void ok;
      continue;
    }
    positionals.push(token);
    index += 1;
  }
  return { occurrences, positionals, errors };
}

/** Convert a config object into per-option occurrences, validating types. */
export function parseConfig(
  specs: OptionSpec[],
  config: Record<string, unknown>,
): { occurrences: Map<string, Occurrence[]>; errors: ParamError[] } {
  const byName = new Map<string, OptionSpec>();
  for (const spec of specs) byName.set(spec.name, spec);

  const occurrences = new Map<string, Occurrence[]>();
  const errors: ParamError[] = [];

  for (const [key, raw] of Object.entries(config)) {
    const ref: SourceRef = { layer: "config", position: `config.${key}` };
    const spec = byName.get(key);
    if (!spec) {
      errors.push({ message: `unknown config key "${key}"`, source: ref });
      continue;
    }
    const typeOf = (v: unknown): string => (Array.isArray(v) ? "array" : typeof v);
    switch (spec.type) {
      case "boolean":
        if (typeof raw !== "boolean") {
          errors.push({
            message: `config key "${key}": expected boolean, got ${typeOf(raw)}`,
            source: ref,
          });
          break;
        }
        occurrences.set(key, [{ value: raw, ref }]);
        break;
      case "string":
        if (typeof raw !== "string") {
          errors.push({
            message: `config key "${key}": expected string, got ${typeOf(raw)}`,
            source: ref,
          });
          break;
        }
        occurrences.set(key, [{ value: raw, ref }]);
        break;
      case "number":
        if (typeof raw !== "number" || Number.isNaN(raw)) {
          errors.push({
            message: `config key "${key}": expected number, got ${typeOf(raw)}`,
            source: ref,
          });
          break;
        }
        occurrences.set(key, [{ value: raw, ref }]);
        break;
      case "list": {
        const items = Array.isArray(raw) ? raw : [raw];
        const bad = items.find((item) => typeof item !== "string");
        if (bad !== undefined) {
          errors.push({
            message: `config key "${key}": expected string array, got ${typeOf(bad)} element`,
            source: ref,
          });
          break;
        }
        occurrences.set(
          key,
          items.map((item) => ({ value: item, ref })),
        );
        break;
      }
    }
  }
  return { occurrences, errors };
}

/** Merge defaults, config and CLI occurrences into final values. */
export function resolve(input: ResolveInput): Resolved {
  const { specs, config = {}, argv = [], mutexGroups = [] } = input;
  const errors: ParamError[] = [];

  const cli = parseArgv(specs, argv);
  const cfg = parseConfig(specs, config);
  errors.push(...cli.errors, ...cfg.errors);

  // Per-option occurrences grouped by layer, in encounter order.
  const layersOf = new Map<string, Map<Layer, Occurrence[]>>();
  const addAll = (name: string, layer: Layer, occs: Occurrence[]): void => {
    if (occs.length === 0) return;
    let byLayer = layersOf.get(name);
    if (!byLayer) {
      byLayer = new Map();
      layersOf.set(name, byLayer);
    }
    const list = byLayer.get(layer);
    if (list) list.push(...occs);
    else byLayer.set(layer, [...occs]);
  };

  for (const spec of specs) {
    if (spec.default === undefined) continue;
    const ref: SourceRef = { layer: "default", position: "default" };
    const occs =
      spec.type === "list"
        ? (spec.default as string[]).map((item) => ({ value: item, ref }))
        : [{ value: spec.default, ref }];
    addAll(spec.name, "default", occs);
  }
  for (const [name, occs] of cfg.occurrences) addAll(name, "config", occs);
  for (const [name, occs] of cli.occurrences) addAll(name, "cli", occs);

  const values: Record<string, unknown> = {};
  const sources: Record<string, SourceRef> = {};

  for (const spec of specs) {
    const byLayer = layersOf.get(spec.name);
    if (!byLayer) continue;
    // Highest layer that has at least one occurrence wins.
    let best: Occurrence[] | undefined;
    for (const layer of ["default", "config", "cli"] as Layer[]) {
      const occs = byLayer.get(layer);
      if (occs && occs.length > 0) best = occs;
    }
    if (!best || best.length === 0) continue;
    if (spec.type === "list") {
      // Same layer accumulates; the winning layer replaces lower layers.
      values[spec.name] = best.map((occ) => occ.value as string);
      sources[spec.name] = (best[0] as Occurrence).ref;
    } else {
      // Single value: last occurrence of the winning layer.
      const last = best[best.length - 1] as Occurrence;
      values[spec.name] = last.value;
      sources[spec.name] = last.ref;
    }
  }

  // Mutex groups are checked against the final merged values. A member is
  // "set" when its final value was explicitly provided via config or cli.
  const known = new Set(specs.map((spec) => spec.name));
  for (const group of mutexGroups) {
    for (const name of group) {
      if (!known.has(name)) {
        errors.push({ message: `mutex group references unknown option "${name}"`, source: null });
      }
    }
    const setMembers = group.filter((name) => {
      const source = sources[name];
      return source !== undefined && source.layer !== "default";
    });
    if (setMembers.length > 1) {
      const detail = setMembers
        .map((name) => `--${name} (${formatRef(sources[name] as SourceRef)})`)
        .join(", ");
      errors.push({
        message: `mutually exclusive options set together: ${detail}`,
        source: sources[setMembers[setMembers.length - 1] as string] ?? null,
      });
    }
  }

  return { values, sources, positionals: cli.positionals, errors };
}
