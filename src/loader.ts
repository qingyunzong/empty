import { posix } from 'node:path';

export type VirtualFileTable =
  | ReadonlyMap<string, string>
  | Readonly<Record<string, string>>;

export class ConfigError extends Error {
  readonly includePath: readonly string[];

  constructor(message: string, includePath: readonly string[]) {
    super(`${message} (include path: ${includePath.join(' -> ')})`);
    this.name = 'ConfigError';
    this.includePath = [...includePath];
  }
}

export interface LoadResult {
  config: Record<string, unknown>;
  /** Dot-path -> ordered chain of files that contributed to the final value. */
  provenance: ReadonlyMap<string, readonly string[]>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizePath(path: string): string {
  return posix.normalize(path);
}

function resolveInclude(fromFile: string, spec: string): string {
  return normalizePath(posix.join(posix.dirname(fromFile), spec));
}

function joinPath(base: string, key: string): string {
  return base ? `${base}.${key}` : key;
}

function recordSource(
  provenance: Map<string, string[]>,
  path: string,
  file: string,
): void {
  const chain = provenance.get(path);
  if (chain) {
    chain.push(file);
  } else {
    provenance.set(path, [file]);
  }
}

function dropSubtree(
  provenance: Map<string, string[]>,
  prefix: string,
): void {
  for (const key of [...provenance.keys()]) {
    if (key === prefix || key.startsWith(`${prefix}.`)) {
      provenance.delete(key);
    }
  }
}

function includeSpecs(
  value: unknown,
  file: string,
  includePath: readonly string[],
): string[] {
  if (value === undefined) return [];
  if (typeof value === 'string') return [value];
  if (Array.isArray(value) && value.every((v) => typeof v === 'string')) {
    return value as string[];
  }
  throw new ConfigError(
    `"include" must be a string or an array of strings in ${file}`,
    includePath,
  );
}

/**
 * Merge an already-loaded subtree into the accumulator.
 * Provenance for the subtree's leaves was recorded when it was loaded;
 * here we only drop stale entries when a value is replaced wholesale.
 */
function mergeTrees(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
  basePath: string,
  provenance: Map<string, string[]>,
): Record<string, unknown> {
  for (const [key, value] of Object.entries(source)) {
    const path = joinPath(basePath, key);
    const existing = target[key];
    if (isPlainObject(existing) && isPlainObject(value)) {
      mergeTrees(existing, value, path, provenance);
    } else if (Array.isArray(existing) && Array.isArray(value)) {
      existing.push(...value);
    } else {
      if (isPlainObject(existing) || Array.isArray(existing)) {
        dropSubtree(provenance, path);
      }
      // Clone: the same subtree may be merged into several parents (diamond).
      target[key] = structuredClone(value);
    }
  }
  return target;
}

/** Apply a file's own keys on top of its merged includes, recording provenance. */
function applyOwnKeys(
  target: Record<string, unknown>,
  own: Record<string, unknown>,
  file: string,
  basePath: string,
  provenance: Map<string, string[]>,
): void {
  for (const [key, value] of Object.entries(own)) {
    if (key === 'include') continue;
    const path = joinPath(basePath, key);
    const existing = target[key];
    if (isPlainObject(value)) {
      if (!isPlainObject(existing)) {
        if (existing !== undefined) dropSubtree(provenance, path);
        target[key] = {};
      }
      applyOwnKeys(target[key] as Record<string, unknown>, value, file, path, provenance);
    } else if (Array.isArray(value) && Array.isArray(existing)) {
      existing.push(...value);
      recordSource(provenance, path, file);
    } else {
      if (isPlainObject(existing) || Array.isArray(existing)) {
        dropSubtree(provenance, path);
      }
      target[key] = value;
      recordSource(provenance, path, file);
    }
  }
}

export class ConfigLoader {
  readonly #files: ReadonlyMap<string, string>;

  constructor(files: VirtualFileTable) {
    this.#files =
      files instanceof Map ? files : new Map(Object.entries(files));
  }

  load(entry: string): LoadResult {
    const provenance = new Map<string, string[]>();
    const config = this.#loadFile(normalizePath(entry), [], provenance);
    return { config, provenance };
  }

  #loadFile(
    path: string,
    stack: string[],
    provenance: Map<string, string[]>,
  ): Record<string, unknown> {
    if (stack.includes(path)) {
      const cycle = [...stack, path];
      throw new ConfigError(
        `Circular include detected: ${cycle.join(' -> ')}`,
        cycle,
      );
    }
    const raw = this.#files.get(path);
    if (raw === undefined) {
      throw new ConfigError(`Config file not found: ${path}`, [...stack, path]);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (cause) {
      throw new ConfigError(
        `Invalid JSON in ${path}: ${(cause as Error).message}`,
        [...stack, path],
      );
    }
    if (!isPlainObject(parsed)) {
      throw new ConfigError(
        `Config file must contain a JSON object: ${path}`,
        [...stack, path],
      );
    }

    const nextStack = [...stack, path];
    let merged: Record<string, unknown> = {};
    for (const spec of includeSpecs(parsed.include, path, nextStack)) {
      const child = this.#loadFile(resolveInclude(path, spec), nextStack, provenance);
      merged = mergeTrees(merged, child, '', provenance);
    }
    applyOwnKeys(merged, parsed, path, '', provenance);
    return merged;
  }
}

export function loadConfig(
  entry: string,
  files: VirtualFileTable,
): LoadResult {
  return new ConfigLoader(files).load(entry);
}
