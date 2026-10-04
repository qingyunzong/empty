import { createHash } from "node:crypto";
import { Rational } from "./rational.js";
export class SignalSeries {
    config;
    slots = [];
    /** Indices of the most recent (<= k) sample slots, oldest first. */
    windowIdx = [];
    sumW = Rational.zero();
    sumWV = Rational.zero();
    trailingMissing = 0;
    constructor(config) {
        if (!Number.isInteger(config.k) || config.k < 1) {
            throw new Error(`k must be a positive integer, got ${config.k}`);
        }
        if (!Number.isInteger(config.period) || config.period < 1) {
            throw new Error(`period must be a positive integer, got ${config.period}`);
        }
        this.config = { k: config.k, period: config.period };
    }
    get size() {
        return this.slots.length;
    }
    slotKind(index) {
        const slot = this.slots[index];
        if (!slot)
            throw new Error(`slot index out of range: ${index}`);
        return slot.kind;
    }
    /** Appends a valid sample at the next time position. */
    appendSample(value, weight) {
        const w = BigInt(weight);
        if (w < 0n)
            throw new Error(`weight must be a non-negative integer, got ${weight}`);
        const slot = { kind: "sample", value: Rational.from(value), weight: w };
        const index = this.slots.length;
        this.slots.push(slot);
        this.trailingMissing = 0;
        // Incremental window maintenance: only the new slot enters; existing
        // gap distances are untouched by appending a sample.
        const effW = this.effectiveWeightAt(index);
        this.windowIdx.push(index);
        this.sumW = this.sumW.add(effW);
        this.sumWV = this.sumWV.add(effW.mul(slot.value));
        if (this.windowIdx.length > this.config.k) {
            const evicted = this.windowIdx.shift();
            const evictedW = this.effectiveWeightAt(evicted);
            const evictedSlot = this.slots[evicted];
            this.sumW = this.sumW.sub(evictedW);
            this.sumWV = this.sumWV.sub(evictedW.mul(evictedSlot.value));
        }
    }
    /** Appends a missing slot: it occupies a time position but carries no weight. */
    appendMissing() {
        // The sample immediately before the trailing gap run sees its gapAfter
        // grow by one; adjust its window contribution in place if it is windowed.
        const lastSample = this.slots.length - this.trailingMissing - 1;
        if (lastSample >= 0) {
            const before = this.effectiveWeightAt(lastSample);
            this.slots.push({ kind: "missing" });
            this.trailingMissing += 1;
            const after = this.effectiveWeightAt(lastSample);
            const pos = this.windowIdx.indexOf(lastSample);
            if (pos >= 0) {
                const delta = after.sub(before);
                const slot = this.slots[lastSample];
                this.sumW = this.sumW.add(delta);
                this.sumWV = this.sumWV.add(delta.mul(slot.value));
            }
            return;
        }
        this.slots.push({ kind: "missing" });
        this.trailingMissing += 1;
    }
    /** Corrects the value/weight of an existing sample slot. */
    correct(index, value, weight) {
        this.mustBeSample(index);
        const w = BigInt(weight);
        if (w < 0n)
            throw new Error(`weight must be a non-negative integer, got ${weight}`);
        this.slots[index] = { kind: "sample", value: Rational.from(value), weight: w };
        this.recomputeWindow();
    }
    /**
     * Deletes a sample: its slot becomes missing (keeps its time position,
     * loses its weight). Subsequent windows and neighbouring weights change.
     */
    delete(index) {
        this.mustBeSample(index);
        this.slots[index] = { kind: "missing" };
        this.recomputeWindow();
    }
    /**
     * Weighted average of the most recent k valid samples, or null when the
     * window is empty or every weight in it is zero.
     */
    average() {
        if (this.sumW.isZero())
            return null;
        return this.sumWV.div(this.sumW);
    }
    /** True once the window holds a full set of k valid samples. */
    isWindowClosed() {
        return this.windowIdx.length >= this.config.k;
    }
    /** Indices of the samples currently in the window (oldest first). */
    windowIndices() {
        return this.windowIdx;
    }
    /** Effective weight of a slot under the phase + gap-distance model. */
    effectiveWeightAt(index) {
        const slot = this.slots[index];
        if (!slot)
            throw new Error(`slot index out of range: ${index}`);
        if (slot.kind !== "sample" || slot.weight === 0n)
            return Rational.zero();
        const period = this.config.period;
        const phaseNum = BigInt(period + (index % period));
        const gapDen = BigInt(1 + this.gapBefore(index) + this.gapAfter(index));
        return Rational.of(slot.weight * phaseNum, BigInt(period) * gapDen);
    }
    /**
     * Forks the series. Slots are immutable, so the branch shares structure
     * with the old view; corrections on the branch never leak back.
     */
    branch() {
        const fork = new SignalSeries(this.config);
        fork.slots = this.slots.slice();
        fork.recomputeWindow();
        return fork;
    }
    /**
     * Serializes the full resumable state: every slot, the current (possibly
     * unclosed) window, and a summary of the source stream.
     */
    checkpoint() {
        return {
            version: 1,
            config: { ...this.config },
            slots: this.slots.map((slot) => slot.kind === "sample"
                ? { t: "s", v: slot.value.toString(), w: slot.weight.toString() }
                : { t: "m" }),
            window: {
                indices: [...this.windowIdx],
                closed: this.isWindowClosed(),
                sumW: this.sumW.toString(),
                sumWV: this.sumWV.toString(),
            },
            sourceSummary: this.summarize(this.slots),
        };
    }
    /**
     * Resumes from a checkpoint. Both the carried window and the source
     * summary are validated against the slot data; any mismatch aborts the
     * resume instead of silently continuing from corrupt state.
     */
    static resume(checkpoint) {
        if (checkpoint.version !== 1) {
            throw new Error(`unsupported checkpoint version: ${checkpoint.version}`);
        }
        if (!checkpoint.window || !checkpoint.sourceSummary) {
            throw new Error("checkpoint must carry the window state and the source summary");
        }
        const series = new SignalSeries(checkpoint.config);
        series.slots = checkpoint.slots.map((slot) => slot.t === "s"
            ? { kind: "sample", value: Rational.from(slot.v), weight: BigInt(slot.w) }
            : { kind: "missing" });
        const summary = series.summarize(series.slots);
        const expected = checkpoint.sourceSummary;
        if (summary.checksum !== expected.checksum ||
            summary.totalSlots !== expected.totalSlots ||
            summary.sampleCount !== expected.sampleCount ||
            summary.missingCount !== expected.missingCount ||
            summary.nextIndex !== expected.nextIndex) {
            throw new Error("checkpoint source summary does not match slot data");
        }
        series.recomputeWindow();
        const carried = checkpoint.window.indices;
        if (carried.length !== series.windowIdx.length ||
            carried.some((idx, pos) => idx !== series.windowIdx[pos]) ||
            checkpoint.window.closed !== series.isWindowClosed() ||
            Rational.from(checkpoint.window.sumW).equals(series.sumW) === false ||
            Rational.from(checkpoint.window.sumWV).equals(series.sumWV) === false) {
            throw new Error("checkpoint window state does not match slot data");
        }
        return series;
    }
    mustBeSample(index) {
        const slot = this.slots[index];
        if (!slot)
            throw new Error(`slot index out of range: ${index}`);
        if (slot.kind !== "sample")
            throw new Error(`slot ${index} is missing, not a sample`);
        return slot;
    }
    gapBefore(index) {
        let count = 0;
        for (let i = index - 1; i >= 0 && this.slots[i].kind === "missing"; i--)
            count++;
        return count;
    }
    gapAfter(index) {
        let count = 0;
        for (let i = index + 1; i < this.slots.length && this.slots[i].kind === "missing"; i++)
            count++;
        return count;
    }
    /** Full window rebuild; used after corrections, deletions and forks. */
    recomputeWindow() {
        this.windowIdx = [];
        for (let i = this.slots.length - 1; i >= 0 && this.windowIdx.length < this.config.k; i--) {
            if (this.slots[i].kind === "sample")
                this.windowIdx.push(i);
        }
        this.windowIdx.reverse();
        this.sumW = Rational.zero();
        this.sumWV = Rational.zero();
        for (const index of this.windowIdx) {
            const effW = this.effectiveWeightAt(index);
            const slot = this.slots[index];
            this.sumW = this.sumW.add(effW);
            this.sumWV = this.sumWV.add(effW.mul(slot.value));
        }
        let trailing = 0;
        for (let i = this.slots.length - 1; i >= 0 && this.slots[i].kind === "missing"; i--)
            trailing++;
        this.trailingMissing = trailing;
    }
    summarize(slots) {
        const hash = createHash("sha256");
        let sampleCount = 0;
        let missingCount = 0;
        for (const slot of slots) {
            if (slot.kind === "sample") {
                sampleCount++;
                hash.update(`s:${slot.value.toString()}:${slot.weight.toString()};`);
            }
            else {
                missingCount++;
                hash.update("m;");
            }
        }
        return {
            totalSlots: slots.length,
            sampleCount,
            missingCount,
            nextIndex: slots.length,
            checksum: hash.digest("hex"),
        };
    }
}
