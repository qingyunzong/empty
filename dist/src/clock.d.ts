import { type TimeInput } from "./track.js";
/**
 * A manually driven clock. It never reads the wall clock: time only
 * advances through tick(), so pause/resume is exact and deterministic.
 */
export declare class Clock {
    private position;
    private running;
    constructor(start?: TimeInput);
    get time(): bigint;
    get isRunning(): boolean;
    /** Advances by delta integer units when running; a no-op while paused. */
    tick(delta?: TimeInput): bigint;
    pause(): void;
    /** Resumes exactly where the clock paused; no wall-clock catch-up. */
    resume(): void;
    seek(t: TimeInput): void;
}
