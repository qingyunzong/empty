"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TempoMap = exports.MS_PER_MINUTE = void 0;
const fraction_1 = require("./fraction");
exports.MS_PER_MINUTE = 60000;
/**
 * Piecewise-constant tempo map. Beat positions are exact rationals;
 * every beat maps to an exact rational millisecond offset.
 * Tempo edits never move beats — only the ms projection changes.
 */
class TempoMap {
    points = [{ beat: fraction_1.Fraction.ZERO, bpm: fraction_1.Fraction.of(120) }];
    undoStack = [];
    events = [];
    static clonePoints(points) {
        return points.map((p) => ({ beat: p.beat, bpm: p.bpm }));
    }
    /** Insert or replace a tempo point. Pushes an undo entry. */
    setTempo(beatLike, bpmLike) {
        const beat = fraction_1.Fraction.from(beatLike);
        const bpm = fraction_1.Fraction.from(bpmLike);
        if (beat.sign() < 0)
            throw new Error("TempoMap: beat must be >= 0");
        if (bpm.sign() <= 0)
            throw new Error("TempoMap: bpm must be > 0");
        this.undoStack.push(TempoMap.clonePoints(this.points));
        const idx = this.points.findIndex((p) => p.beat.eq(beat));
        if (idx >= 0) {
            this.points[idx] = { beat, bpm };
        }
        else {
            this.points.push({ beat, bpm });
            this.points.sort((a, b) => a.beat.cmp(b.beat));
        }
    }
    /** Restore the tempo state from before the most recent setTempo. */
    undo() {
        const prev = this.undoStack.pop();
        if (!prev)
            return false;
        this.points = prev;
        return true;
    }
    get undoDepth() {
        return this.undoStack.length;
    }
    get tempoPoints() {
        return this.points;
    }
    msPerBeatAt(index) {
        return fraction_1.Fraction.of(exports.MS_PER_MINUTE).div(this.points[index].bpm);
    }
    /** Cumulative exact ms at each tempo point. */
    cumulativeMs() {
        const cum = [fraction_1.Fraction.ZERO];
        for (let i = 1; i < this.points.length; i++) {
            const span = this.points[i].beat.sub(this.points[i - 1].beat);
            cum.push(cum[i - 1].add(span.mul(this.msPerBeatAt(i - 1))));
        }
        return cum;
    }
    segmentIndexAtBeat(beat) {
        let i = this.points.length - 1;
        while (i > 0 && this.points[i].beat.gt(beat))
            i--;
        return i;
    }
    /** Exact rational ms offset for a beat position. */
    beatsToMs(beatLike) {
        const beat = fraction_1.Fraction.from(beatLike);
        if (beat.sign() < 0)
            throw new Error("TempoMap: beat must be >= 0");
        const cum = this.cumulativeMs();
        const i = this.segmentIndexAtBeat(beat);
        return cum[i].add(beat.sub(this.points[i].beat).mul(this.msPerBeatAt(i)));
    }
    /** Exact rational beat position for a ms offset. */
    msToBeats(msLike) {
        const ms = fraction_1.Fraction.from(msLike);
        if (ms.sign() < 0)
            throw new Error("TempoMap: ms must be >= 0");
        const cum = this.cumulativeMs();
        let i = cum.length - 1;
        while (i > 0 && cum[i].gt(ms))
            i--;
        return this.points[i].beat.add(ms.sub(cum[i]).div(this.msPerBeatAt(i)));
    }
    bpmAt(beatLike) {
        const beat = fraction_1.Fraction.from(beatLike);
        return this.points[this.segmentIndexAtBeat(beat)].bpm;
    }
    segments() {
        const cum = this.cumulativeMs();
        return this.points.map((p, i) => ({
            index: i,
            startBeat: p.beat,
            endBeat: i + 1 < this.points.length ? this.points[i + 1].beat : null,
            bpm: p.bpm,
            msPerBeat: this.msPerBeatAt(i),
            startMs: cum[i],
            endMs: i + 1 < this.points.length ? cum[i + 1] : null,
        }));
    }
    addEvent(id, track, beatLike) {
        const beat = fraction_1.Fraction.from(beatLike);
        if (beat.sign() < 0)
            throw new Error("TempoMap: event beat must be >= 0");
        const ev = { id, track, beat };
        this.events.push(ev);
        return ev;
    }
    get eventList() {
        return this.events;
    }
    /**
     * Events projected to ms, ordered by (beat, track, id).
     * Beat order equals ms order because the map is monotonic.
     */
    timeline() {
        return this.events
            .map((e) => ({ ...e, ms: this.beatsToMs(e.beat) }))
            .sort((a, b) => a.beat.cmp(b.beat) ||
            a.track - b.track ||
            (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    }
}
exports.TempoMap = TempoMap;
