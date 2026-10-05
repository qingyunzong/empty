import { Rng } from "./rng.js";
import { Tree } from "./tree.js";
export interface Arbitrary<T> {
    generate(rng: Rng): Tree<T>;
}
export declare function arb<T>(gen: (rng: Rng) => Tree<T>): Arbitrary<T>;
export declare function constant<T>(value: T): Arbitrary<T>;
export declare function integer(min: number, max: number): Arbitrary<number>;
export declare function boolean(): Arbitrary<boolean>;
export declare function map<A, B>(a: Arbitrary<A>, f: (x: A) => B): Arbitrary<B>;
/**
 * Restrict values to a contract. Generation retries until a valid value is
 * produced; the shrink tree is filtered so every candidate the property
 * ever sees satisfies the contract.
 */
export declare function filter<A>(a: Arbitrary<A>, ok: (v: A) => boolean, maxTries?: number): Arbitrary<A>;
export declare function tuple<A extends readonly unknown[]>(...arbs: {
    [K in keyof A]: Arbitrary<A[K]>;
}): Arbitrary<A>;
export declare function oneOf<A>(...arbs: Arbitrary<A>[]): Arbitrary<A>;
export interface ArrayOptions {
    minLength?: number;
    maxLength?: number;
}
/**
 * Shared sequence shrinker. Shrink order: shorter prefixes (halving the
 * removed tail), single-element removals, then element-wise shrinks — so
 * the greedy shrinker finds short counterexamples before refining contents.
 */
export declare function buildArrayTree<A>(items: Tree<A>[], minLength: number): Tree<A[]>;
export declare function array<A>(item: Arbitrary<A>, opts?: ArrayOptions): Arbitrary<A[]>;
