import { type TransitionTable, rules } from "./table.js";
import { utcToLocal } from "./mapping.js";

/**
 * One half-open UTC interval of the inverse image, annotated with the offset
 * rule(s) it originates from. ruleIndices has more than one entry only when
 * equivalent adjacent segments (same offset, contiguous domains — e.g. across
 * a redundant same-offset transition) were merged.
 */
export interface UtcIntervalSegment {
  readonly utcStart: number; // finite: local bounds are finite
  readonly utcEnd: number;
  readonly offsetSeconds: number;
  readonly ruleIndices: readonly number[];
}

/**
 * Inverse image of a local half-open interval [localStart, localEnd):
 * every UTC second u with localStart <= utcToLocal(u) < localEnd.
 *
 * Computed per offset rule as
 *   [max(ruleStart, localStart - o), min(ruleEnd, localEnd - o))
 * which splits the result wherever a transition is crossed. Gaps contribute
 * nothing (their local seconds have no preimage); overlaps contribute one
 * segment per covering rule. Adjacent segments sharing the same offset rule
 * are merged into one equivalent segment.
 *
 * Segments are returned sorted by utcStart, half-open and non-overlapping.
 */
export function localIntervalToUtc(
  table: TransitionTable,
  localStart: number,
  localEnd: number,
): UtcIntervalSegment[] {
  if (!Number.isInteger(localStart) || !Number.isInteger(localEnd)) {
    throw new RangeError("local interval bounds must be integer seconds");
  }
  if (!(localStart < localEnd)) {
    throw new RangeError(`empty local interval [${localStart}, ${localEnd})`);
  }
  const merged: UtcIntervalSegment[] = [];
  for (const rule of rules(table)) {
    const start = Math.max(rule.utcStart, localStart - rule.offsetSeconds);
    const end = Math.min(rule.utcEnd, localEnd - rule.offsetSeconds);
    if (!(start < end)) continue;
    const last = merged[merged.length - 1];
    if (last !== undefined && last.offsetSeconds === rule.offsetSeconds && last.utcEnd === start) {
      merged[merged.length - 1] = {
        utcStart: last.utcStart,
        utcEnd: end,
        offsetSeconds: last.offsetSeconds,
        ruleIndices: [...last.ruleIndices, rule.ruleIndex],
      };
    } else {
      merged.push({
        utcStart: start,
        utcEnd: end,
        offsetSeconds: rule.offsetSeconds,
        ruleIndices: [rule.ruleIndex],
      });
    }
  }
  return merged;
}

export interface InverseImageVerification {
  readonly localStart: number;
  readonly localEnd: number;
  readonly scanStart: number;
  readonly scanEnd: number;
  readonly checked: number;
  readonly failures: readonly string[];
}

/**
 * Exhaustive short-domain verification of localIntervalToUtc: scans every UTC
 * second in the segments' span plus `padding` on both sides and asserts
 *   u in preimage  <=>  localStart <= utcToLocal(u) < localEnd.
 * Also asserts the segments are sorted, half-open and non-overlapping.
 */
export function verifyInverseImage(
  table: TransitionTable,
  localStart: number,
  localEnd: number,
  padding = 2,
): InverseImageVerification {
  const segments = localIntervalToUtc(table, localStart, localEnd);
  const failures: string[] = [];
  for (let i = 0; i < segments.length; i += 1) {
    const seg = segments[i]!;
    if (!(seg.utcStart < seg.utcEnd)) {
      failures.push(`segment ${i} is empty or inverted`);
    }
    const prev = segments[i - 1];
    if (prev !== undefined && prev.utcEnd > seg.utcStart) {
      failures.push(`segments ${i - 1} and ${i} overlap or are unsorted`);
    }
  }
  let scanStart = localStart;
  let scanEnd = localEnd;
  if (segments.length > 0) {
    scanStart = segments[0]!.utcStart - padding;
    scanEnd = segments[segments.length - 1]!.utcEnd + padding;
  }
  for (let utc = scanStart; utc < scanEnd; utc += 1) {
    const inPreimage = segments.some((s) => utc >= s.utcStart && utc < s.utcEnd);
    const local = utcToLocal(table, utc).local;
    const inInterval = local >= localStart && local < localEnd;
    if (inPreimage !== inInterval) {
      failures.push(
        `utc ${utc}: inPreimage=${inPreimage} but local=${local} inInterval=${inInterval}`,
      );
    }
  }
  return {
    localStart,
    localEnd,
    scanStart,
    scanEnd,
    checked: scanEnd - scanStart,
    failures,
  };
}
