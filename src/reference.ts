import { Rational } from "./rational.js";
import type { SignalConfig, SlotValue } from "./signal.js";

/**
 * Reference model: the "full precise resample + reweight" oracle. It keeps a
 * plain event log, rebuilds the whole timeline from scratch after every
 * event, and computes each score by direct fraction arithmetic. It shares no
 * windowing code with SignalSeries, so agreement between the two is a real
 * cross-check rather than a tautology.
 */

export type ReferenceEvent =
  | { readonly op: "sample"; readonly value: SlotValue; readonly weight: number | bigint }
  | { readonly op: "missing" }
  | { readonly op: "correct"; readonly index: number; readonly value: SlotValue; readonly weight: number | bigint }
  | { readonly op: "delete"; readonly index: number }
  | { readonly op: "query" };

interface RefSlot {
  value: Rational;
  weight: bigint;
}

/** Replays events; returns one exact score (or null) per `query` event. */
export function runReference(
  events: readonly ReferenceEvent[],
  config: SignalConfig,
): Array<Rational | null> {
  const timeline: Array<RefSlot | null> = [];
  const scores: Array<Rational | null> = [];
  for (const event of events) {
    switch (event.op) {
      case "sample": {
        const weight = BigInt(event.weight);
        if (weight < 0n) throw new Error("negative weight");
        timeline.push({ value: Rational.from(event.value), weight });
        break;
      }
      case "missing":
        timeline.push(null);
        break;
      case "correct": {
        const slot = timeline[event.index];
        if (!slot) throw new Error(`cannot correct slot ${event.index}`);
        timeline[event.index] = { value: Rational.from(event.value), weight: BigInt(event.weight) };
        break;
      }
      case "delete":
        if (!timeline[event.index]) throw new Error(`cannot delete slot ${event.index}`);
        timeline[event.index] = null;
        break;
      case "query":
        scores.push(directScore(timeline, config));
        break;
    }
  }
  return scores;
}

/** Direct fraction computation over the most recent k valid samples. */
function directScore(timeline: ReadonlyArray<RefSlot | null>, config: SignalConfig): Rational | null {
  const window: number[] = [];
  for (let i = timeline.length - 1; i >= 0 && window.length < config.k; i--) {
    if (timeline[i]) window.push(i);
  }
  let sumW = Rational.zero();
  let sumWV = Rational.zero();
  for (const index of window) {
    const slot = timeline[index] as RefSlot;
    if (slot.weight === 0n) continue;
    // Independent restatement of the weighting model: time phase times
    // inverse distance to the surrounding dropouts.
    let gapBefore = 0;
    let cursor = index - 1;
    while (cursor >= 0 && timeline[cursor] === null) {
      gapBefore++;
      cursor--;
    }
    let gapAfter = 0;
    cursor = index + 1;
    while (cursor < timeline.length && timeline[cursor] === null) {
      gapAfter++;
      cursor++;
    }
    const phaseNum = BigInt(config.period + (index % config.period));
    const effW = Rational.of(
      slot.weight * phaseNum,
      BigInt(config.period) * BigInt(1 + gapBefore + gapAfter),
    );
    sumW = sumW.add(effW);
    sumWV = sumWV.add(effW.mul(slot.value));
  }
  if (sumW.isZero()) return null;
  return sumWV.div(sumW);
}
