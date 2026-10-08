/**
 * anchor-patch: content-anchored, atomic patch application.
 *
 * A patch carries the ORIGINAL content (`old`) of the range it modifies and
 * the replacement (`new`). Locations are resolved against the current target
 * text by searching for `old`, so a target that has already drifted from the
 * baseline is still patched correctly as long as the anchored content is
 * present exactly once. Multiple matches are reported as ambiguity and never
 * guessed; all patches are validated before any of them is applied.
 */

/** Needles at or below this length are treated as "small strings": every
 *  repeated occurrence is enumerated with a context excerpt in the evidence
 *  so a human can cross-check the ambiguity report. */
export const SMALL_STRING_THRESHOLD = 8;

/** Characters of surrounding context shown in candidate excerpts. */
export const EXCERPT_CONTEXT = 24;

export interface Patch {
  /** Optional caller-chosen identifier, echoed in evidence and errors. */
  readonly id?: string;
  /** Original content of the modified range (the location anchor). */
  readonly old: string;
  /** Replacement content. */
  readonly new: string;
  /** Expected offset in the BASELINE, if known. Used as evidence only:
   *  it never disambiguates multiple matches. */
  readonly hint?: number;
}

export type LocateStatus = "unique" | "ambiguous" | "not-found";

export interface Candidate {
  /** Offset of this occurrence in the target text. */
  readonly offset: number;
  /** Target excerpt around the occurrence: `before >>>match<<< after`. */
  readonly excerpt: string;
}

export interface LocateEvidence {
  readonly patchIndex: number;
  readonly id?: string;
  readonly status: LocateStatus;
  /** True when `old.length <= SMALL_STRING_THRESHOLD`. */
  readonly smallString: boolean;
  readonly oldLength: number;
  readonly matchCount: number;
  /** Every occurrence of `old` in the target, enumerated and cross-checked. */
  readonly candidates: readonly Candidate[];
  /** Set only when status is "unique". */
  readonly chosenOffset?: number;
  readonly hint?: number;
  /** Whether the target at `hint` starts with `old`. */
  readonly hintMatched?: boolean;
}

export interface InversePatch {
  readonly id?: string;
  /** Offset in the PATCHED output where the inverse applies. */
  readonly offset: number;
  /** Content to locate when reverting (equals the forward patch's `new`). */
  readonly old: string;
  /** Content to restore when reverting (equals the forward patch's `old`). */
  readonly new: string;
}

export interface ApplySuccess {
  readonly ok: true;
  readonly output: string;
  /** Inverse patches in output coordinates; reverting restores the target. */
  readonly inverse: readonly InversePatch[];
  readonly evidence: readonly LocateEvidence[];
}

export interface ApplyFailure {
  readonly ok: false;
  readonly errors: readonly string[];
  readonly evidence: readonly LocateEvidence[];
}

export type ApplyResult = ApplySuccess | ApplyFailure;

function patchLabel(patch: Patch, index: number): string {
  return patch.id !== undefined ? `patch "${patch.id}"` : `patch #${index}`;
}

/** Enumerate ALL occurrences of `needle` in `haystack`, including
 *  overlapping ones, so repeated small strings are fully cross-checked. */
export function enumerateOccurrences(haystack: string, needle: string): number[] {
  const offsets: number[] = [];
  if (needle.length === 0) return offsets;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return offsets;
    offsets.push(at);
    from = at + 1;
  }
}

function excerpt(target: string, offset: number, length: number): string {
  const beforeStart = Math.max(0, offset - EXCERPT_CONTEXT);
  const afterEnd = Math.min(target.length, offset + length + EXCERPT_CONTEXT);
  const before = target.slice(beforeStart, offset);
  const match = target.slice(offset, offset + length);
  const after = target.slice(offset + length, afterEnd);
  const leftEllipsis = beforeStart > 0 ? "..." : "";
  const rightEllipsis = afterEnd < target.length ? "..." : "";
  return `${leftEllipsis}${before}>>>${match}<<<${after}${rightEllipsis}`;
}

/** Locate one patch against the target. Never guesses: a unique match is
 *  required; zero matches is "not-found", more than one is "ambiguous". */
export function locate(target: string, patch: Patch, patchIndex = 0): LocateEvidence {
  const offsets = enumerateOccurrences(target, patch.old);
  const candidates: Candidate[] = offsets.map((offset) => ({
    offset,
    excerpt: excerpt(target, offset, patch.old.length),
  }));
  const status: LocateStatus =
    offsets.length === 0 ? "not-found" : offsets.length === 1 ? "unique" : "ambiguous";
  const base = {
    patchIndex,
    smallString: patch.old.length <= SMALL_STRING_THRESHOLD,
    oldLength: patch.old.length,
    matchCount: offsets.length,
    candidates,
    status,
  };
  const withId = patch.id !== undefined ? { ...base, id: patch.id } : base;
  const withHint =
    patch.hint !== undefined
      ? { ...withId, hint: patch.hint, hintMatched: target.startsWith(patch.old, patch.hint) }
      : withId;
  const only = offsets[0];
  if (status === "unique" && only !== undefined) {
    return { ...withHint, chosenOffset: only };
  }
  return withHint;
}

interface Located {
  readonly patch: Patch;
  readonly index: number;
  readonly offset: number;
}

/**
 * Validate every patch against the target, then apply all of them
 * atomically. If any patch fails to locate uniquely, or two located ranges
 * overlap, nothing is applied and the failure carries the full evidence.
 */
export function applyPatches(target: string, patches: readonly Patch[]): ApplyResult {
  const errors: string[] = [];
  const evidence: LocateEvidence[] = [];
  const located: Located[] = [];

  for (let i = 0; i < patches.length; i++) {
    const patch = patches[i]!;
    const label = patchLabel(patch, i);
    if (patch.old.length === 0) {
      errors.push(`${label}: "old" must be non-empty (pure insertion is not supported)`);
      continue;
    }
    const ev = locate(target, patch, i);
    evidence.push(ev);
    if (ev.status === "not-found") {
      errors.push(`${label}: original content not found in target`);
    } else if (ev.status === "ambiguous") {
      errors.push(
        `${label}: ambiguous, ${ev.matchCount} matches at offsets ${ev.candidates
          .map((c) => c.offset)
          .join(", ")}; refusing to guess`,
      );
    } else {
      located.push({ patch, index: i, offset: ev.chosenOffset! });
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors, evidence };
  }

  const sorted = [...located].sort((a, b) => a.offset - b.offset);
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]!;
    const curr = sorted[i]!;
    if (prev.offset + prev.patch.old.length > curr.offset) {
      return {
        ok: false,
        errors: [
          `${patchLabel(prev.patch, prev.index)} and ${patchLabel(curr.patch, curr.index)}: ` +
            `located ranges overlap at offsets ${prev.offset} and ${curr.offset}`,
        ],
        evidence,
      };
    }
  }

  // Rebuild the output left to right, tracking the coordinate shift so
  // inverse patches can be expressed in output offsets.
  let output = "";
  let cursor = 0;
  let shift = 0;
  const inverseByIndex = new Map<number, InversePatch>();
  for (const loc of sorted) {
    output += target.slice(cursor, loc.offset);
    output += loc.patch.new;
    cursor = loc.offset + loc.patch.old.length;
    const inverse: InversePatch = {
      offset: loc.offset + shift,
      old: loc.patch.new,
      new: loc.patch.old,
    };
    inverseByIndex.set(
      loc.index,
      loc.patch.id !== undefined ? { ...inverse, id: loc.patch.id } : inverse,
    );
    shift += loc.patch.new.length - loc.patch.old.length;
  }
  output += target.slice(cursor);

  const inverse = patches.map((_, i) => inverseByIndex.get(i)!);
  return { ok: true, output, inverse, evidence };
}

/** Revert a previously applied result: applies the inverse patches through
 *  the same atomic machinery, restoring the original target. */
export function revert(output: string, inverse: readonly InversePatch[]): ApplyResult {
  return applyPatches(
    output,
    inverse.map((inv) => {
      const patch: Patch = { old: inv.old, new: inv.new, hint: inv.offset };
      return inv.id !== undefined ? { ...patch, id: inv.id } : patch;
    }),
  );
}
