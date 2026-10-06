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

interface Snapshot {
  clips: Clip[];
  nextId: number;
  nextSeq: number;
  version: number;
}

export class SubtitleTrack {
  private clips: Clip[] = [];
  private nextId = 1;
  private nextSeq = 0;
  private history: Snapshot[] = [];

  /** Current version; increments on every mutation, restored by undo. */
  get version(): number {
    return this.versionValue;
  }
  private versionValue = 0;

  /** Read-only view of the live clips. */
  getClips(): readonly Clip[] {
    return this.clips.map((c) => ({ ...c }));
  }

  /** Insert a clip on `layer` over half-open [start, end). Returns clip id. */
  insert(start: number, end: number, layer = 0): number {
    assertValidRange(start, end);
    this.commit();
    const clip: Clip = {
      id: this.nextId++,
      start,
      end,
      layer,
      seq: this.nextSeq++,
    };
    this.clips.push(clip);
    return clip.id;
  }

  /**
   * Trim clip `id` to the intersection of its interval with [start, end).
   * If the intersection is empty the clip is removed.
   * Returns false when the clip does not exist.
   */
  crop(id: number, start: number, end: number): boolean {
    assertValidRange(start, end);
    const index = this.clips.findIndex((c) => c.id === id);
    if (index < 0) return false;
    this.commit();
    const clip = this.clips[index]!;
    const s = Math.max(clip.start, start);
    const e = Math.min(clip.end, end);
    if (s >= e) {
      this.clips.splice(index, 1);
    } else {
      this.clips[index] = { ...clip, start: s, end: e };
    }
    return true;
  }

  /** Remove clip `id`. Returns false when the clip does not exist. */
  remove(id: number): boolean {
    const index = this.clips.findIndex((c) => c.id === id);
    if (index < 0) return false;
    this.commit();
    this.clips.splice(index, 1);
    return true;
  }

  /**
   * Undo the most recent mutation, restoring the exact state and version
   * from before it. Returns false when there is nothing to undo.
   */
  undo(): boolean {
    const snapshot = this.history.pop();
    if (!snapshot) return false;
    this.clips = snapshot.clips;
    this.nextId = snapshot.nextId;
    this.nextSeq = snapshot.nextSeq;
    this.versionValue = snapshot.version;
    return true;
  }

  /** Number of undoable mutations currently on the stack. */
  get undoDepth(): number {
    return this.history.length;
  }

  /** The clip visible at time `t` (ms), or null. */
  visibleAt(t: number): Clip | null {
    let best: Clip | null = null;
    for (const clip of this.clips) {
      if (clip.start <= t && t < clip.end && beats(clip, best)) {
        best = clip;
      }
    }
    return best ? { ...best } : null;
  }

  /**
   * Maximal continuous visible segments with their source clip.
   * Adjacent elementary intervals showing the same clip are merged, so
   * each returned segment is as long as possible.
   */
  visibleSegments(): VisibleSegment[] {
    const points = new Set<number>();
    for (const clip of this.clips) {
      points.add(clip.start);
      points.add(clip.end);
    }
    const sorted = [...points].sort((a, b) => a - b);

    const segments: VisibleSegment[] = [];
    for (let i = 0; i + 1 < sorted.length; i++) {
      const start = sorted[i]!;
      const end = sorted[i + 1]!;
      if (start >= end) continue;
      const winner = this.visibleAt(start);
      if (!winner) continue;
      const last = segments[segments.length - 1];
      if (last && last.end === start && last.clipId === winner.id) {
        segments[segments.length - 1] = { ...last, end };
      } else {
        segments.push({
          start,
          end,
          clipId: winner.id,
          layer: winner.layer,
        });
      }
    }
    return segments;
  }

  private commit(): void {
    this.history.push({
      clips: this.clips.map((c) => ({ ...c })),
      nextId: this.nextId,
      nextSeq: this.nextSeq,
      version: this.versionValue,
    });
    this.versionValue++;
  }
}

/** True when `a` occludes `b` (higher layer, or same layer but later insert). */
function beats(a: Clip, b: Clip | null): boolean {
  if (b === null) return true;
  if (a.layer !== b.layer) return a.layer > b.layer;
  return a.seq > b.seq;
}

function assertValidRange(start: number, end: number): void {
  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    end <= start
  ) {
    throw new RangeError(
      `invalid half-open interval [${start}, ${end}): need integers with 0 <= start < end`,
    );
  }
}
