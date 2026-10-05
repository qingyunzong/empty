import type { MatchInfo, Range } from "./types.js";
import { SourceMap } from "./map.js";
import {
  replaceAll,
  type ReplaceOptions,
  type ReplaceResult,
} from "./replace.js";

interface Snapshot {
  text: string;
  map: SourceMap;
}

/**
 * Holds a text through multiple replacement rounds. Before each round is
 * bound, the current state is snapshotted, so any round can be rolled back.
 * The composed map always points from the current text to the original
 * source. A failed round (invalid reference, budget overflow) leaves the
 * session untouched.
 */
export class ReplaceSession {
  #text: string;
  #map: SourceMap;
  #history: Snapshot[] = [];

  constructor(source: string) {
    this.#text = source;
    this.#map = SourceMap.identity(source.length);
  }

  get text(): string {
    return this.#text;
  }

  /** Composed map from the current text back to the original source. */
  get map(): SourceMap {
    return this.#map;
  }

  /** Number of applied (not yet rolled back) rounds. */
  get depth(): number {
    return this.#history.length;
  }

  apply(
    matches: MatchInfo[],
    template: string,
    options: ReplaceOptions = {},
  ): ReplaceResult {
    const snapshot: Snapshot = { text: this.#text, map: this.#map };
    const result = replaceAll(this.#text, matches, template, options);
    this.#history.push(snapshot);
    this.#text = result.text;
    this.#map = this.#map.compose(result.map);
    return result;
  }

  /** Restores the state from before the most recent round. */
  rollback(): boolean {
    const prev = this.#history.pop();
    if (prev === undefined) return false;
    this.#text = prev.text;
    this.#map = prev.map;
    return true;
  }

  sourcePositionAt(outPos: number): number | null {
    return this.#map.sourcePositionAt(outPos);
  }

  outputRangesForSource(srcPos: number): Range[] {
    return this.#map.outputRangesForSource(srcPos);
  }
}
