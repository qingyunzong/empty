"use strict";
/**
 * WeightedRankIndex maintains a mutable set of weighted observations and
 * answers mid-distribution percentile queries:
 *
 *   percentile(x) = (W_less + 0.5 * W_equal) / W_total
 *
 * where W_less is the total weight of observations with value strictly less
 * than x, W_equal the total weight of observations with value equal to x,
 * and W_total the total weight of all observations.
 *
 * Updates and deletes are exact: setting an id twice replaces its previous
 * contribution, and deleting an id removes exactly the contribution that was
 * added. Internally distinct values are kept in a sorted array with a
 * Fenwick (binary indexed) tree over aggregated per-value weights.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.WeightedRankIndex = void 0;
class WeightedRankIndex {
    observations = new Map();
    values = []; // sorted distinct values
    slotWeights = []; // aggregated weight per distinct value
    bit = []; // Fenwick tree, 1-based, length values.length + 1
    totalWeight = 0;
    get size() {
        return this.observations.size;
    }
    get total() {
        return this.totalWeight;
    }
    has(id) {
        return this.observations.has(id);
    }
    get(id) {
        const found = this.observations.get(id);
        return found === undefined ? undefined : { ...found };
    }
    /** Insert a new observation or exactly replace an existing one. */
    set(id, value, weight) {
        if (!Number.isFinite(value))
            throw new RangeError(`value must be finite, got ${value}`);
        if (!Number.isFinite(weight) || weight < 0) {
            throw new RangeError(`weight must be a finite number >= 0, got ${weight}`);
        }
        const previous = this.observations.get(id);
        if (previous !== undefined) {
            this.removeContribution(previous.value, previous.weight);
        }
        this.observations.set(id, { value, weight });
        this.addContribution(value, weight);
    }
    /** Remove an observation exactly. Returns false when the id is unknown. */
    delete(id) {
        const previous = this.observations.get(id);
        if (previous === undefined)
            return false;
        this.observations.delete(id);
        this.removeContribution(previous.value, previous.weight);
        return true;
    }
    /**
     * Mid-distribution percentile of `value`: (W_less + 0.5 * W_equal) / W_total.
     * Returns null when the index is empty or the total weight is zero.
     */
    percentileOf(value) {
        if (this.observations.size === 0 || this.totalWeight <= 0)
            return null;
        const slot = this.lowerBound(value);
        const less = this.bitPrefix(slot);
        const equal = slot < this.values.length && this.values[slot] === value ? this.slotWeights[slot] : 0;
        return (less + 0.5 * equal) / this.totalWeight;
    }
    /**
     * Percentile scores of all current observations, keyed by id.
     * Returns an empty map for an empty (or zero-total-weight) index.
     */
    scores() {
        const out = new Map();
        if (this.observations.size === 0 || this.totalWeight <= 0)
            return out;
        for (const [id, obs] of this.observations) {
            out.set(id, this.percentileOf(obs.value));
        }
        return out;
    }
    /** Total weight of observations with value strictly less than `value`. */
    weightLessThan(value) {
        return this.bitPrefix(this.lowerBound(value));
    }
    /** Snapshot of current observations as plain entries (insertion order). */
    entries() {
        return [...this.observations.entries()].map(([id, o]) => [id, { ...o }]);
    }
    lowerBound(x) {
        let lo = 0;
        let hi = this.values.length;
        while (lo < hi) {
            const mid = (lo + hi) >>> 1;
            if (this.values[mid] < x)
                lo = mid + 1;
            else
                hi = mid;
        }
        return lo;
    }
    bitAdd(index, delta) {
        for (let x = index + 1; x < this.bit.length; x += x & -x)
            this.bit[x] += delta;
    }
    /** Sum of the first `count` slots, i.e. slots [0, count). */
    bitPrefix(count) {
        let sum = 0;
        for (let x = count; x > 0; x -= x & -x)
            sum += this.bit[x];
        return sum;
    }
    rebuildBit() {
        this.bit = new Array(this.values.length + 1).fill(0);
        for (let i = 0; i < this.slotWeights.length; i++)
            this.bitAdd(i, this.slotWeights[i]);
    }
    addContribution(value, weight) {
        const slot = this.lowerBound(value);
        if (slot < this.values.length && this.values[slot] === value) {
            this.slotWeights[slot] += weight;
            this.bitAdd(slot, weight);
        }
        else {
            this.values.splice(slot, 0, value);
            this.slotWeights.splice(slot, 0, weight);
            this.rebuildBit();
        }
        this.totalWeight += weight;
    }
    removeContribution(value, weight) {
        const slot = this.lowerBound(value);
        this.slotWeights[slot] -= weight;
        this.bitAdd(slot, -weight);
        this.totalWeight -= weight;
    }
}
exports.WeightedRankIndex = WeightedRankIndex;
