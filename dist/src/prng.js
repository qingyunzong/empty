"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Prng = void 0;
/**
 * mulberry32 — a small deterministic PRNG with an explicitly serializable
 * 32-bit state. Snapshots capture `getState()` and restores use `setState()`,
 * which is what makes segmented runs bit-for-bit reproducible.
 */
class Prng {
    state;
    constructor(seed) {
        this.state = seed >>> 0;
    }
    /** Next float in [0, 1). */
    next() {
        this.state = (this.state + 0x6d2b79f5) >>> 0;
        let t = this.state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }
    /** Uniformly pick one element. */
    pick(items) {
        if (items.length === 0)
            throw new Error("Prng.pick: empty list");
        const index = Math.floor(this.next() * items.length);
        return items[index];
    }
    getState() {
        return this.state;
    }
    setState(state) {
        this.state = state >>> 0;
    }
}
exports.Prng = Prng;
