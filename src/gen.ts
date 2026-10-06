import { Rng } from "./rng";
import { Tree, pure, mapTree } from "./tree";

/** A generator produces a shrinkable value from an Rng and a size hint. */
export type Gen<T> = (rng: Rng, size: number) => Tree<T>;

/** Integer in [min, max]; shrinks towards the value closest to 0 in range. */
export function integer(min: number, max: number): Gen<number> {
  return (rng) => intTree(rng.nextInt(min, max), shrinkTarget(min, max));
}

function shrinkTarget(min: number, max: number): number {
  if (min <= 0 && max >= 0) return 0;
  return Math.abs(min) <= Math.abs(max) ? min : max;
}

function intTree(value: number, target: number): Tree<number> {
  return {
    value,
    *shrinks() {
      // Candidates approach `target` by halving the distance:
      // value=100, target=0 -> 50, 25, 12, 6, 3, 1, 0.
      let diff = value - target;
      while (diff !== 0) {
        diff = Math.trunc(diff / 2);
        yield intTree(target + diff, target);
      }
      // Unit step as a last resort: halving alone can strand the
      // shrinker at a local minimum (e.g. from 6 the halvings are
      // 3, 1, 0 -- 5 is unreachable without a single step).
      const step = value - Math.sign(value - target);
      if (step !== target && value !== target) {
        yield intTree(step, target);
      }
    },
  };
}

export function boolean(): Gen<boolean> {
  return (rng) => {
    const value = rng.nextBoolean();
    return {
      value,
      *shrinks() {
        if (value) yield pure(false);
      },
    };
  };
}

export function constant<T>(value: T): Gen<T> {
  return () => pure(value);
}

export function map<A, B>(gen: Gen<A>, f: (a: A) => B): Gen<B> {
  return (rng, size) => mapTree(gen(rng, size), f);
}

export function oneOf<T>(...gens: Gen<T>[]): Gen<T> {
  if (gens.length === 0) throw new Error("oneOf needs at least one generator");
  return (rng, size) => {
    const picked = gens[rng.nextInt(0, gens.length - 1)]!;
    return picked(rng, size);
  };
}

export interface ArrayOptions {
  minLength?: number;
  maxLength?: number;
}

export function arrayOf<T>(gen: Gen<T>, options: ArrayOptions = {}): Gen<T[]> {
  return (rng, size) => {
    const minLen = options.minLength ?? 0;
    const maxLen = options.maxLength ?? Math.max(minLen, size);
    const length = rng.nextInt(minLen, maxLen);
    const items: Tree<T>[] = [];
    for (let i = 0; i < length; i++) {
      items.push(gen(rng, size));
    }
    return arrayTree(items, minLen);
  };
}

function arrayTree<T>(items: Tree<T>[], minLen: number): Tree<T[]> {
  return {
    value: items.map((t) => t.value),
    *shrinks() {
      // 1. Shrink the length towards minLen by halving (keep prefixes).
      let diff = items.length - minLen;
      while (diff > 0) {
        diff = Math.trunc(diff / 2);
        yield arrayTree(items.slice(0, minLen + diff), minLen);
      }
      // 2. Remove single elements (any position), respecting minLen.
      if (items.length > minLen) {
        for (let i = 0; i < items.length; i++) {
          yield arrayTree([...items.slice(0, i), ...items.slice(i + 1)], minLen);
        }
      }
      // 3. Shrink individual elements, one position at a time.
      for (let i = 0; i < items.length; i++) {
        for (const child of items[i]!.shrinks()) {
          const copy = items.slice();
          copy[i] = child;
          yield arrayTree(copy, minLen);
        }
      }
    },
  };
}

/** Lowercase alphabetic strings; length and characters both shrink. */
export function stringOf(charGen: Gen<string>, options: ArrayOptions = {}): Gen<string> {
  return map(arrayOf(charGen, options), (chars) => chars.join(""));
}

export function lowerAlpha(): Gen<string> {
  return map(integer(97, 122), (code) => String.fromCharCode(code));
}
