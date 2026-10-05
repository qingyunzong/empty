import { tree, mapTree, filterTree } from "./tree.js";
export function arb(gen) {
    return { generate: gen };
}
export function constant(value) {
    return arb(() => tree(value, function* () { }));
}
/** Shrink candidates walking from `v` toward `target` by halving the gap. */
function towards(target, v) {
    if (v === target)
        return [];
    const out = [target];
    let gap = v - target;
    while (Math.abs(gap) > 1) {
        gap = Math.trunc(gap / 2);
        out.push(v - gap);
    }
    return out;
}
function intTree(v, target) {
    return tree(v, function* () {
        for (const c of towards(target, v))
            yield intTree(c, target);
    });
}
export function integer(min, max) {
    const target = min <= 0 && max >= 0 ? 0 : Math.abs(min) <= Math.abs(max) ? min : max;
    return arb((rng) => intTree(rng.nextInt(min, max), target));
}
export function boolean() {
    return arb((rng) => tree(rng.nextBool(), function* () {
        yield tree(false, function* () { });
    }));
}
export function map(a, f) {
    return arb((rng) => mapTree(a.generate(rng), f));
}
/**
 * Restrict values to a contract. Generation retries until a valid value is
 * produced; the shrink tree is filtered so every candidate the property
 * ever sees satisfies the contract.
 */
export function filter(a, ok, maxTries = 100) {
    return arb((rng) => {
        for (let i = 0; i < maxTries; i++) {
            const t = a.generate(rng);
            if (ok(t.value))
                return filterTree(t, ok);
        }
        throw new Error("filter: could not generate a value satisfying the contract");
    });
}
export function tuple(...arbs) {
    return arb((rng) => {
        const trees = arbs.map((a) => a.generate(rng.fork()));
        const build = (ts) => tree(ts.map((t) => t.value), function* () {
            for (let i = 0; i < ts.length; i++) {
                for (const c of ts[i].children()) {
                    const next = ts.slice();
                    next[i] = c;
                    yield build(next);
                }
            }
        });
        return build(trees);
    });
}
export function oneOf(...arbs) {
    return arb((rng) => arbs[rng.nextInt(0, arbs.length - 1)].generate(rng.fork()));
}
/**
 * Shared sequence shrinker. Shrink order: shorter prefixes (halving the
 * removed tail), single-element removals, then element-wise shrinks — so
 * the greedy shrinker finds short counterexamples before refining contents.
 */
export function buildArrayTree(items, minLength) {
    return tree(items.map((t) => t.value), function* () {
        let removable = items.length - minLength;
        while (removable > 0) {
            yield buildArrayTree(items.slice(0, items.length - removable), minLength);
            removable = Math.trunc(removable / 2);
        }
        for (let i = 0; i < items.length; i++) {
            if (items.length - 1 >= minLength) {
                yield buildArrayTree([...items.slice(0, i), ...items.slice(i + 1)], minLength);
            }
        }
        for (let i = 0; i < items.length; i++) {
            for (const c of items[i].children()) {
                const next = items.slice();
                next[i] = c;
                yield buildArrayTree(next, minLength);
            }
        }
    });
}
export function array(item, opts = {}) {
    const minLength = opts.minLength ?? 0;
    const maxLength = opts.maxLength ?? 16;
    return arb((rng) => {
        const len = rng.nextInt(minLength, maxLength);
        const items = [];
        for (let i = 0; i < len; i++)
            items.push(item.generate(rng.fork()));
        return buildArrayTree(items, minLength);
    });
}
