import { Rational } from "./rational";

export interface MusicEvent {
  readonly id: string;
  readonly track: number;
  /** Canonical position: a rational beat. Never rewritten by tempo changes. */
  readonly beat: Rational;
  readonly kind: string;
}

/** Order by beat, then track, then id — total and deterministic. */
export function compareEvents(a: MusicEvent, b: MusicEvent): number {
  const byBeat = a.beat.cmp(b.beat);
  if (byBeat !== 0) return byBeat;
  if (a.track !== b.track) return a.track - b.track;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
