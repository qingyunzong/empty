import {
  affectedComponent,
  assignLines,
  compareSubtitles,
  layoutAll,
} from "./layout.js";
import {
  subtitleEquals,
  validateSubtitle,
  type Subtitle,
} from "./types.js";

/**
 * An immutable snapshot of a line assignment. Instances are never
 * mutated after creation; every engine update publishes a new one.
 */
export class LayoutVersion {
  readonly #lines: ReadonlyMap<string, number>;

  /** @internal */
  constructor(version: number, lines: ReadonlyMap<string, number>) {
    this.version = version;
    this.#lines = lines;
    Object.freeze(this);
  }

  /** Monotonically increasing version number, starting at 0. */
  readonly version: number;

  /** Read-only view of the full id -> starting-line assignment. */
  get lines(): ReadonlyMap<string, number> {
    return this.#lines;
  }

  get size(): number {
    return this.#lines.size;
  }

  lineOf(id: string): number | undefined {
    return this.#lines.get(id);
  }

  has(id: string): boolean {
    return this.#lines.has(id);
  }
}

/** A correction batch: removals are applied before upserts. */
export interface LayoutChange {
  readonly remove?: Iterable<string>;
  readonly upsert?: Iterable<Subtitle>;
}

/**
 * Incremental subtitle layout engine.
 *
 * Holds the current subtitle set and, for each correction, re-lays out
 * only the affected connected component of the old/new time-overlap
 * graph; every other subtitle keeps its line. The result is guaranteed
 * to equal a full recompute (`layoutAll`) of the corrected set, because
 * no subtitle outside the component conflicts with — or transitively
 * depends on — any subtitle inside it.
 */
export class SubtitleLayoutEngine {
  #subtitles = new Map<string, Subtitle>();
  #lines = new Map<string, number>();
  readonly #versions: LayoutVersion[] = [];

  constructor(initial: Iterable<Subtitle> = []) {
    const list = [...initial].map((s) => validateSubtitle({ ...s }));
    for (const sub of list) {
      if (this.#subtitles.has(sub.id)) {
        throw new Error(`duplicate subtitle id: ${sub.id}`);
      }
      this.#subtitles.set(sub.id, sub);
    }
    this.#lines = layoutAll(list);
    this.#versions.push(new LayoutVersion(0, this.#lines));
  }

  /** Current subtitle set, in (start, id) order. */
  get subtitles(): readonly Subtitle[] {
    return [...this.#subtitles.values()].sort(compareSubtitles);
  }

  /** The latest layout version. */
  get currentVersion(): LayoutVersion {
    return this.#versions[this.#versions.length - 1];
  }

  get versionCount(): number {
    return this.#versions.length;
  }

  /** Query a historical immutable layout version. */
  version(index: number): LayoutVersion | undefined {
    return this.#versions[index];
  }

  /**
   * Apply a correction and return the new immutable layout version.
   * Removals are applied before upserts; unknown removed ids and
   * upserts identical to the stored subtitle are no-ops.
   */
  update(change: LayoutChange): LayoutVersion {
    const removed = [...(change.remove ?? [])];
    const upserted = [...(change.upsert ?? [])].map((s) =>
      validateSubtitle({ ...s }),
    );

    const seeds = new Set<string>();
    for (const id of removed) {
      if (this.#subtitles.has(id)) seeds.add(id);
    }
    for (const sub of upserted) {
      const previous = this.#subtitles.get(sub.id);
      if (previous === undefined || !subtitleEquals(previous, sub)) {
        seeds.add(sub.id);
      }
    }

    const next = new Map(this.#subtitles);
    for (const id of removed) next.delete(id);
    for (const sub of upserted) next.set(sub.id, sub);

    let nextLines: Map<string, number>;
    if (seeds.size === 0) {
      nextLines = new Map(this.#lines);
    } else {
      const component = affectedComponent(this.#subtitles, next, seeds);
      nextLines = new Map<string, number>();
      // Subtitles outside the component keep their lines.
      for (const [id, line] of this.#lines) {
        if (!component.has(id) && next.has(id)) nextLines.set(id, line);
      }
      // Re-lay out component members still present after the change.
      // Fixed outsiders need not be passed as constraints: by
      // construction nothing outside the component time-overlaps (let
      // alone conflicts with) any member's old or new interval.
      const members: Subtitle[] = [];
      for (const id of component) {
        const sub = next.get(id);
        if (sub !== undefined) members.push(sub);
      }
      for (const [id, line] of assignLines(members)) {
        nextLines.set(id, line);
      }
    }

    this.#subtitles = next;
    this.#lines = nextLines;
    const version = new LayoutVersion(this.#versions.length, nextLines);
    this.#versions.push(version);
    return version;
  }
}
