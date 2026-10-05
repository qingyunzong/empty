export type Scalar = string | number | boolean | null;

export type TransformFn = (value: Scalar) => Scalar;

const registry = new Map<string, TransformFn>();

export function registerTransform(name: string, fn: TransformFn): void {
  if (registry.has(name)) {
    throw new Error(`transform already registered: ${name}`);
  }
  registry.set(name, fn);
}

export function hasTransform(name: string): boolean {
  return registry.has(name);
}

export function applyChain(value: Scalar, chain: readonly string[]): Scalar {
  let current = value;
  for (const name of chain) {
    const fn = registry.get(name);
    if (!fn) {
      throw new Error(`unknown transform: ${name}`);
    }
    current = fn(current);
  }
  return current;
}

registerTransform("trim", (v) => (typeof v === "string" ? v.trim() : v));
registerTransform("lower", (v) => (typeof v === "string" ? v.toLowerCase() : v));
registerTransform("upper", (v) => (typeof v === "string" ? v.toUpperCase() : v));
registerTransform("normalizeSpace", (v) =>
  typeof v === "string" ? v.trim().replace(/\s+/g, " ") : v,
);
registerTransform("round2", (v) =>
  typeof v === "number" ? Math.round(v * 100) / 100 : v,
);
registerTransform("trunc", (v) =>
  typeof v === "number" ? Math.trunc(v) : v,
);
