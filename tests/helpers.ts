/** Deterministic PRNG (mulberry32) so randomized tests are reproducible. */
export class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  int(bound: number): number {
    return Math.floor(this.next() * bound);
  }

  pick<T>(items: T[]): T {
    return items[this.int(items.length)];
  }
}

export function makeSource(rng: Rng, self: string, allNames: string[]): string {
  const lines: string[] = [];
  const others = allNames.filter((name) => name !== self);
  const depCount = others.length === 0 ? 0 : rng.int(Math.min(3, others.length) + 1);
  const deps = new Set<string>();
  for (let i = 0; i < depCount; i += 1) deps.add(rng.pick(others));
  for (const dep of [...deps].sort()) {
    lines.push(`import { v_${dep} } from "${dep}";`);
  }
  lines.push(`const memo_${self} = ${rng.int(100000)};`);
  lines.push(`export const v_${self} = ${rng.int(100000)};`);
  return lines.join("\n") + "\n";
}

/** Rewrite only the private implementation line; the export stays identical. */
export function tweakImpl(source: string, rng: Rng): string {
  return source.replace(/const memo_(\w+) = \d+;/, `const memo_$1 = ${rng.int(100000)};`);
}

/** Rewrite the exported value; the public interface changes. */
export function tweakIface(source: string, rng: Rng): string {
  return source.replace(/export const v_(\w+) = \d+;/, `export const v_$1 = ${rng.int(100000)};`);
}

/** Add an import line (may create a cycle) or remove an existing one. */
export function tweakDeps(source: string, self: string, allNames: string[], rng: Rng): string {
  const imports = source.split("\n").filter((line) => line.startsWith("import "));
  if (imports.length > 0 && rng.int(2) === 0) {
    const victim = rng.pick(imports);
    return source
      .split("\n")
      .filter((line) => line !== victim)
      .join("\n");
  }
  const others = allNames.filter((name) => name !== self && !source.includes(`"${name}"`));
  if (others.length === 0) return tweakIface(source, rng);
  const dep = rng.pick(others);
  return `import { v_${dep} } from "${dep}";\n` + source;
}
