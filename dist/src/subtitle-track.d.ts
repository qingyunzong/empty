/**
 * Layered subtitle interval track.
 *
 * - Intervals are half-open: [start, end), unit = milliseconds.
 * - Overlap resolution: higher layer occludes lower layer; on the same
 *   layer the later-inserted clip wins.
 * - Every mutation (insert / crop / remove) creates a new version and is
 *   undoable; undo restores the exact state and version from before the
 *   mutation.
 */
export interface Clip {
    /** Stable clip identifier, unique within a track. */
    readonly id: number;
    /** Inclusive start, ms. */
    readonly start: number;
    /** Exclusive end, ms. */
    readonly end: number;
    /** Z-order layer; higher occludes lower. */
    readonly layer: number;
    /** Monotonic insertion order; breaks ties within a layer. */
    readonly seq: number;
}
export interface VisibleSegment {
    /** Inclusive start, ms. */
    readonly start: number;
    /** Exclusive end, ms. */
    readonly end: number;
    /** Source clip visible over the whole segment. */
    readonly clipId: number;
    readonly layer: number;
}
export declare class SubtitleTrack {
    private clips;
    private nextId;
    private nextSeq;
    private history;
    /** Current version; increments on every mutation, restored by undo. */
    get version(): number;
    private versionValue;
    /** Read-only view of the live clips. */
    getClips(): readonly Clip[];
    /** Insert a clip on `layer` over half-open [start, end). Returns clip id. */
    insert(start: number, end: number, layer?: number): number;
    /**
     * Trim clip `id` to the intersection of its interval with [start, end).
     * If the intersection is empty the clip is removed.
     * Returns false when the clip does not exist.
     */
    crop(id: number, start: number, end: number): boolean;
    /** Remove clip `id`. Returns false when the clip does not exist. */
    remove(id: number): boolean;
    /**
     * Undo the most recent mutation, restoring the exact state and version
     * from before it. Returns false when there is nothing to undo.
     */
    undo(): boolean;
    /** Number of undoable mutations currently on the stack. */
    get undoDepth(): number;
    /** The clip visible at time `t` (ms), or null. */
    visibleAt(t: number): Clip | null;
    /**
     * Maximal continuous visible segments with their source clip.
     * Adjacent elementary intervals showing the same clip are merged, so
     * each returned segment is as long as possible.
     */
    visibleSegments(): VisibleSegment[];
    private commit;
}
