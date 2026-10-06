import { Rng } from "./rng.js";

/**
 * A generator of values of type T.
 *
 * - `generate` draws a random value from an explicit Rng (no hidden state).
 * - `shrink`   enumerates strictly "smaller" candidates for a value.
 * - `smalls`   is a fixed, deterministic list of small/edge cases that is
 *              always checked before any random case (a stable baseline
 *              that does not depend on seeds at all).
 */
export interface Gen<T> {
  generate(rng: Rng): T;
  shrink(value: T): Iterable<T>;
  smalls(): T[];
}

function* shrinkTowards(value: number, target: number): Iterable<number> {
  if (value === target) return;
  yield target;
  // Candidates approach `value` from the target side: value-d/2, ..., value-1.
  // Greedy search over this sequence converges to the minimal failing value.
  let half = Math.trunc((value - target) / 2);
  while (half !== 0) {
    yield value - half;
    half = Math.trunc(half / 2);
  }
}

export function integer(min: number, max: number): Gen<number> {
  if (!Number.isInteger(min) || !Number.isInteger(max) || min > max) {
    throw new Error(`invalid integer range [${min}, ${max}]`);
  }
  const target = Math.min(Math.max(0, min), max);
  const smalls: number[] = [];
  for (const candidate of [target, min, max, min + 1, max - 1]) {
    if (candidate >= min && candidate <= max && !smalls.includes(candidate)) {
      smalls.push(candidate);
    }
  }
  return {
    generate: (rng) => rng.nextInt(min, max),
    shrink: (value) => shrinkTowards(value, target),
    smalls: () => [...smalls],
  };
}

export function boolean(): Gen<boolean> {
  return {
    generate: (rng) => rng.nextBool(),
    *shrink(value) {
      if (value) yield false;
    },
    smalls: () => [false, true],
  };
}

export function constant<T>(value: T): Gen<T> {
  return {
    generate: () => value,
    *shrink() {},
    smalls: () => [value],
  };
}

export interface ArrayOptions {
  minLength?: number;
  maxLength?: number;
}

export function arrayOf<T>(item: Gen<T>, options: ArrayOptions = {}): Gen<T[]> {
  const minLength = options.minLength ?? 0;
  const maxLength = options.maxLength ?? 10;
  if (minLength < 0 || maxLength < minLength) {
    throw new Error(`invalid array length range [${minLength}, ${maxLength}]`);
  }
  return {
    generate(rng) {
      const length = rng.nextInt(minLength, maxLength);
      const out: T[] = [];
      for (let i = 0; i < length; i++) out.push(item.generate(rng));
      return out;
    },
      *shrink(value) {
      // 1) Shrink the length: drop halves, then drop single elements.
      if (value.length > minLength) {
        let drop = Math.trunc(value.length / 2);
        while (drop >= 1 && value.length - drop >= minLength) {
          yield value.slice(0, value.length - drop);
          drop = Math.trunc(drop / 2);
        }
        if (minLength === 0) yield [];
        for (let i = 0; i < value.length && value.length - 1 >= minLength; i++) {
          yield [...value.slice(0, i), ...value.slice(i + 1)];
        }
      }
      // 2) Shrink individual elements (earlier elements first).
      for (let i = 0; i < value.length; i++) {
        for (const smaller of item.shrink(value[i])) {
          yield [...value.slice(0, i), smaller, ...value.slice(i + 1)];
        }
      }
    },
    smalls() {
      const out: T[][] = [];
      if (minLength === 0) out.push([]);
      const itemSmalls = item.smalls();
      if (itemSmalls.length > 0 && Math.max(1, minLength) <= maxLength) {
        out.push(new Array(Math.max(1, minLength)).fill(itemSmalls[0]));
      }
      return out;
    },
  };
}

export function stringOf(
  charGen: Gen<string>,
  options: ArrayOptions = {},
): Gen<string> {
  const chars = arrayOf(charGen, options);
  return {
    generate: (rng) => chars.generate(rng).join(""),
    *shrink(value) {
      for (const smaller of chars.shrink([...value])) yield smaller.join("");
    },
    smalls: () => chars.smalls().map((cs) => cs.join("")),
  };
}

export function lowercaseString(options: ArrayOptions = {}): Gen<string> {
  const letters = "abcdefghijklmnopqrstuvwxyz".split("");
  const charGen: Gen<string> = {
    generate: (rng) => rng.pick(letters),
    *shrink(value) {
      const idx = letters.indexOf(value);
      if (idx > 0) {
        yield "a";
        const half = Math.trunc(idx / 2);
        if (half > 0) yield letters[half];
      }
    },
    smalls: () => ["a", "z"],
  };
  return stringOf(charGen, options);
}

export function map<A, B>(gen: Gen<A>, fn: (value: A) => B): Gen<B> {
  return {
    generate: (rng) => fn(gen.generate(rng)),
    // Shrinking through an arbitrary map is not invertible in general;
    // mapped generators only shrink via their fixed small cases.
    *shrink() {},
    smalls: () => gen.smalls().map(fn),
  };
}

export function filter<T>(gen: Gen<T>, keep: (value: T) => boolean): Gen<T> {
  return {
    generate(rng) {
      for (let attempt = 0; attempt < 100; attempt++) {
        const value = gen.generate(rng);
        if (keep(value)) return value;
      }
      throw new Error("filter: could not generate a satisfying value");
    },
    *shrink(value) {
      for (const smaller of gen.shrink(value)) {
        if (keep(smaller)) yield smaller;
      }
    },
    smalls: () => gen.smalls().filter(keep),
  };
}

export function tuple<T extends readonly unknown[]>(
  ...gens: { [K in keyof T]: Gen<T[K]> }
): Gen<T> {
  return {
    generate: (rng) => gens.map((g) => g.generate(rng)) as unknown as T,
    *shrink(value) {
      for (let i = 0; i < gens.length; i++) {
        for (const smaller of (gens[i] as Gen<unknown>).shrink(value[i])) {
          const next = value.slice() as unknown as T;
          (next as unknown as unknown[])[i] = smaller;
          yield next;
        }
      }
    },
    smalls: () => {
      const per = gens.map((g) => g.smalls());
      if (per.some((s) => s.length === 0)) return [];
      return [per.map((s) => s[0]) as unknown as T];
    },
  };
}

export function oneOf<T>(...gens: Gen<T>[]): Gen<T> {
  if (gens.length === 0) throw new Error("oneOf needs at least one generator");
  return {
    generate(rng) {
      return rng.pick(gens).generate(rng);
    },
    *shrink(value) {
      for (const gen of gens) {
        for (const small of gen.smalls()) yield small;
      }
    },
    smalls: () => gens.flatMap((g) => g.smalls().slice(0, 1)),
  };
}
