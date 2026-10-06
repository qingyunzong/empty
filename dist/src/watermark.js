/**
 * Tracks per-partition progress and publishes the global watermark as the
 * minimum max-event-time across currently ACTIVE partitions. Idle partitions
 * (declared via explicit `idle` events) are excluded from the minimum.
 *
 * A data event whose event time is earlier than the already-published global
 * watermark is rejected and recorded; it never mutates partition state.
 */
export class WatermarkTracker {
    partitions = new Map();
    published = null;
    trajectory = [];
    rejections = [];
    /** Apply one event. Returns true if a new global watermark was published. */
    apply(event, eventIndex = this.trajectory.length) {
        switch (event.kind) {
            case "idle": {
                const state = this.stateFor(event.partition);
                state.active = false;
                return this.recompute(eventIndex);
            }
            case "active": {
                const state = this.stateFor(event.partition);
                state.active = true;
                return this.recompute(eventIndex);
            }
            case "data": {
                if (this.published !== null && event.eventTime < this.published) {
                    this.rejections.push({
                        partition: event.partition,
                        eventTime: event.eventTime,
                        publishedWatermark: this.published,
                        reason: "LATE_DATA",
                    });
                    return false;
                }
                const state = this.stateFor(event.partition);
                state.active = true; // arriving data is an explicit liveness signal
                if (state.maxEventTime === null || event.eventTime > state.maxEventTime) {
                    state.maxEventTime = event.eventTime;
                }
                return this.recompute(eventIndex);
            }
        }
    }
    /**
     * Replay an event stream from a fresh tracker and return the full
     * trajectory plus rejections. Verifies that the published watermark is
     * monotonically non-decreasing; throws if a regression is detected.
     */
    static replay(events) {
        const tracker = new WatermarkTracker();
        events.forEach((event, index) => tracker.apply(event, index));
        return tracker.result();
    }
    result() {
        for (let i = 1; i < this.trajectory.length; i++) {
            const prev = this.trajectory[i - 1];
            const curr = this.trajectory[i];
            if (curr.watermark < prev.watermark) {
                throw new Error(`watermark regression at event ${curr.atEventIndex}: ` +
                    `${curr.watermark} < ${prev.watermark}`);
            }
        }
        return {
            trajectory: [...this.trajectory],
            rejections: [...this.rejections],
            finalWatermark: this.published,
        };
    }
    currentWatermark() {
        return this.published;
    }
    stateFor(partition) {
        let state = this.partitions.get(partition);
        if (state === undefined) {
            state = { active: true, maxEventTime: null };
            this.partitions.set(partition, state);
        }
        return state;
    }
    recompute(eventIndex) {
        let min = null;
        for (const state of this.partitions.values()) {
            if (!state.active || state.maxEventTime === null)
                continue;
            if (min === null || state.maxEventTime < min)
                min = state.maxEventTime;
        }
        if (min === null)
            return false;
        if (this.published !== null && min <= this.published)
            return false;
        this.published = min;
        this.trajectory.push({ atEventIndex: eventIndex, watermark: min });
        return true;
    }
}
//# sourceMappingURL=watermark.js.map