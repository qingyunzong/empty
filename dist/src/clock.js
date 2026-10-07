import { toTime } from "./track.js";
/**
 * A manually driven clock. It never reads the wall clock: time only
 * advances through tick(), so pause/resume is exact and deterministic.
 */
export class Clock {
    position;
    running = true;
    constructor(start = 0) {
        this.position = toTime(start);
    }
    get time() {
        return this.position;
    }
    get isRunning() {
        return this.running;
    }
    /** Advances by delta integer units when running; a no-op while paused. */
    tick(delta = 1) {
        if (this.running)
            this.position += toTime(delta);
        return this.position;
    }
    pause() {
        this.running = false;
    }
    /** Resumes exactly where the clock paused; no wall-clock catch-up. */
    resume() {
        this.running = true;
    }
    seek(t) {
        this.position = toTime(t);
    }
}
