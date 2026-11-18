export type MergeRecord = Record<PropertyKey, unknown>;

const propertyIsEnumerable = Object.prototype.propertyIsEnumerable;

export function hasOwn(
  value: object,
  key: PropertyKey,
): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

export function isPlainObject(value: unknown): value is MergeRecord {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function enumerableOwnKeys(value: object): PropertyKey[] {
  return Reflect.ownKeys(value).filter((key) =>
    propertyIsEnumerable.call(value, key),
  );
}

function defineValue(
  target: MergeRecord | unknown[],
  key: PropertyKey,
  value: unknown,
): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

function cloneArray(value: readonly unknown[], seen: WeakMap<object, unknown>): unknown[] {
  const clone = new Array(value.length);
  seen.set(value, clone);
  for (let index = 0; index < value.length; index += 1) {
    if (index in value) {
      clone[index] = cloneValueWithSeen(value[index], seen);
    }
  }
  for (const key of enumerableOwnKeys(value)) {
    if (key === "length") continue;
    defineValue(
      clone,
      key,
      cloneValueWithSeen((value as unknown as MergeRecord)[key], seen),
    );
  }
  return clone;
}

function cloneRecord(value: MergeRecord, seen: WeakMap<object, unknown>): MergeRecord {
  const clone =
    Object.getPrototypeOf(value) === null ? Object.create(null) : {};
  seen.set(value, clone);
  for (const key of enumerableOwnKeys(value)) {
    defineValue(clone, key, cloneValueWithSeen(value[key], seen));
  }
  return clone;
}

/**
 * Clones JSON-like values and common built-ins so merged trees never share
 * mutable containers with their inputs.
 */
export function cloneValue<T>(value: T): T {
  return cloneValueWithSeen(value, new WeakMap()) as T;
}

function cloneValueWithSeen(
  value: unknown,
  seen: WeakMap<object, unknown>,
): unknown {
  if (value === null || typeof value !== "object") return value;

  const previous = seen.get(value);
  if (previous !== undefined) return previous;

  if (Array.isArray(value)) return cloneArray(value, seen);
  if (isPlainObject(value)) return cloneRecord(value, seen);

  if (value instanceof Date) {
    const clone = new Date(value.getTime());
    seen.set(value, clone);
    return clone;
  }

  if (value instanceof RegExp) {
    const clone = new RegExp(value.source, value.flags);
    clone.lastIndex = value.lastIndex;
    seen.set(value, clone);
    return clone;
  }

  if (value instanceof Map) {
    const clone = new Map();
    seen.set(value, clone);
    for (const [key, entry] of value) {
      clone.set(cloneValueWithSeen(key, seen), cloneValueWithSeen(entry, seen));
    }
    return clone;
  }

  if (value instanceof Set) {
    const clone = new Set();
    seen.set(value, clone);
    for (const entry of value) clone.add(cloneValueWithSeen(entry, seen));
    return clone;
  }

  if (value instanceof ArrayBuffer) {
    const clone = value.slice(0);
    seen.set(value, clone);
    return clone;
  }
  if (ArrayBuffer.isView(value)) {
    const buffer = value.buffer.slice(
      value.byteOffset,
      value.byteOffset + value.byteLength,
    );
    const Constructor = (
      value as unknown as { constructor: new (buffer: ArrayBufferLike) => unknown }
    ).constructor;
    if (Constructor.name === "Buffer") {
      const BufferConstructor = Constructor as unknown as {
        from?: (input: Uint8Array) => unknown;
      };
      if (typeof BufferConstructor.from === "function") {
        const clone = BufferConstructor.from(new Uint8Array(buffer));
        seen.set(value, clone);
        return clone;
      }
    }
    try {
      const clone = new Constructor(buffer);
      seen.set(value, clone);
      return clone;
    } catch {
      const clone = new Uint8Array(buffer);
      seen.set(value, clone);
      return clone;
    }
  }

  // Class instances are opaque. Keeping the reference preserves their
  // internal slots, while all containers described by package manifests are
  // cloned above.
  return value;
}

function mergeRecords(
  base: MergeRecord,
  override: MergeRecord,
): MergeRecord {
  const result: MergeRecord =
    Object.getPrototypeOf(base) === null ? Object.create(null) : {};

  for (const key of enumerableOwnKeys(base)) {
    defineValue(result, key, cloneValue(base[key]));
  }

  for (const key of enumerableOwnKeys(override)) {
    const next = override[key];
    if (hasOwn(result, key)) {
      defineValue(result, key, mergeValue(result[key], next));
    } else {
      defineValue(result, key, cloneValue(next));
    }
  }

  return result;
}

function mergeMaps(base: Map<unknown, unknown>, override: Map<unknown, unknown>): Map<unknown, unknown> {
  const result = new Map<unknown, unknown>();
  const index = new Map<unknown, { key: unknown; value: unknown }>();

  for (const [key, value] of base) {
    const clonedKey = cloneValue(key);
    const clonedValue = cloneValue(value);
    result.set(clonedKey, clonedValue);
    index.set(key, { key: clonedKey, value: clonedValue });
  }

  for (const [key, value] of override) {
    const existing = index.get(key);
    if (existing !== undefined) {
      existing.value = mergeValue(existing.value, value);
      result.set(existing.key, existing.value);
      continue;
    }

    const clonedKey = cloneValue(key);
    const clonedValue = cloneValue(value);
    result.set(clonedKey, clonedValue);
    index.set(key, { key: clonedKey, value: clonedValue });
  }

  return result;
}

function mergeValue(base: unknown, override: unknown): unknown {
  if (base instanceof Map && override instanceof Map) {
    return mergeMaps(base, override);
  }
  if (isPlainObject(base) && isPlainObject(override)) {
    return mergeRecords(base, override);
  }
  return cloneValue(override);
}

export function mergeLayers(layers: readonly unknown[]): unknown {
  if (layers.length === 0) return {};

  let result: unknown = undefined;
  let initialized = false;

  for (const layer of layers) {
    if (layer === undefined) continue;
    if (!initialized) {
      result = cloneValue(layer);
      initialized = true;
      continue;
    }

    result = mergeValue(result, layer);
  }

  return initialized ? result : {};
}

/**
 * Deep-merges values from lowest to highest precedence.
 *
 * - Plain records merge key by key.
 * - Arrays and scalars are replaced, never concatenated.
 * - A present key replaces even when its value is null or undefined.
 * - A missing key leaves the lower-precedence value untouched.
 */
export function deepMerge<T>(
  base: T,
  ...overrides: readonly unknown[]
): T {
  return mergeLayers([base, ...overrides]) as T;
}

export const merge = deepMerge;

export function mergePackageValues(
  defaults: unknown,
  packageValues?: unknown,
  overrides?: unknown,
): unknown {
  return mergeLayers([defaults, packageValues, overrides]);
}
