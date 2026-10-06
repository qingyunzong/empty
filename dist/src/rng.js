"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Rng = void 0;
exports.mixSeed = mixSeed;
exports.hashSeed = hashSeed;
/**
 * Deterministic PRNG (mulberry32) whose entire state is a single
 * unsigned 32-bit integer. Every property test gets its own Rng
 * instance derived from (masterSeed, propertyName), so results never
 * depend on test execution order or on any shared mutable state.
 */
class Rng {
    state;
    constructor(seed) {
        this.state = seed >>> 0;
    }
    /** Current integer state; enough to perfectly resume the stream. */
    getState() {
        return this.state >>> 0;
    }
    nextUint32() {
        this.state = (this.state + 0x6d2b79f5) >>> 0;
        let t = this.state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return (t ^ (t >>> 14)) >>> 0;
    }
    /** Uniform integer in [minInclusive, maxInclusive]. */
    nextInt(minInclusive, maxInclusive) {
        if (maxInclusive < minInclusive) {
            throw new Error(`invalid range [${minInclusive}, ${maxInclusive}]`);
        }
        const range = maxInclusive - minInclusive + 1;
        return minInclusive + (this.nextUint32() % range);
    }
    nextBoolean() {
        return (this.nextUint32() & 1) === 1;
    }
    /** Independent child stream, derived purely from current state + salt. */
    fork(salt) {
        return new Rng(mixSeed(this.state, salt));
    }
}
exports.Rng = Rng;
/** Deterministic 32-bit integer mixer (splitmix-style). */
function mixSeed(a, b) {
    let h = (a >>> 0) ^ Math.imul((b >>> 0) + 0x9e3779b9, 0x85ebca6b);
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
    return (h ^ (h >>> 16)) >>> 0;
}
/**
 * FNV-1a style hash of a property name folded into a master seed.
 * This is what makes each property's random stream independent of
 * how many other properties exist or in which order they run.
 */
function hashSeed(masterSeed, name) {
    let h = (masterSeed >>> 0) ^ 0x811c9dc5;
    for (let i = 0; i < name.length; i++) {
        h = Math.imul(h ^ name.charCodeAt(i), 0x01000193) >>> 0;
    }
    return mixSeed(h, name.length);
}
