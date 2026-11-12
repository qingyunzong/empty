import { Rational, type RationalInput } from "./rational.js";
import {
  originalRange,
  parseSrcCandidate,
  parseSrcset,
  type Candidate,
  type CandidateSetIssue,
  type DiscardedCandidate,
  type OriginalRange,
  type ParsedSrcset,
} from "./srcset.js";
import {
  selectSlotWidth,
  type SizeEntry,
  type SlotWidthSelection,
} from "./sizes.js";

export interface SourceInput {
  id?: string;
  srcset: string;
  /** Omitted media matches. */
  media?: string;
  /** Omitted type is supported. */
  type?: string;
  sizes?: readonly SizeEntry[];
}

export interface ImgInput {
  id?: string;
  srcset?: string;
  src?: string;
  sizes?: readonly SizeEntry[];
}

export interface MatchContext {
  kind: "source" | "img" | "sizes";
  sourceIndex: number | null;
  sizeIndex: number | null;
  baseUrl: string;
  viewportWidth: Rational;
  dpr: Rational;
}

export type MediaMatcher = (media: string, context: MatchContext) => boolean;
export type TypeMatcher = (type: string, context: MatchContext) => boolean;

export interface SelectPictureInput {
  sources: readonly SourceInput[];
  img?: ImgInput | null;
  /** Absolute base URL used for every relative candidate URL. */
  baseUrl: string;
  viewportWidth: RationalInput;
  dpr: RationalInput;
  mediaMatches: MediaMatcher;
  supportsType: TypeMatcher;
}

export interface AdoptedSizes {
  index: number | null;
  media: string | null;
  expression: string | null;
  slotWidth: Rational;
  slotWidthNumber: number;
  usedViewportFallback: boolean;
}

export interface AdoptedSource {
  kind: "source" | "img";
  sourceIndex: number | null;
  media: string | null;
  type: string | null;
  sizes: AdoptedSizes | null;
}

export interface SelectedCandidate {
  url: string;
  density: Rational;
  densityText: string;
  densityNumber: number;
  source: "source" | "img";
  sourceIndex: number | null;
  sizesIndex: number | null;
  densityKind: "w" | "x";
  candidate: Candidate;
  slotWidth: Rational | null;
  slotWidthNumber: number | null;
  adopted: AdoptedSource;
  range: OriginalRange;
  raw: string;
}

export interface CandidateSetReport {
  candidates: Candidate[];
  discarded: DiscardedCandidate[];
  issue: CandidateSetIssue | null;
}

export interface SourceEvaluationTrace {
  kind: "source" | "img";
  index: number | null;
  media: string | null;
  type: string | null;
  mediaMatched: boolean;
  typeSupported: boolean;
  candidateSet: CandidateSetReport | null;
}

export interface PictureSelection {
  selected: SelectedCandidate;
  /** Convenience aliases for the selected resource. */
  url: string;
  density: Rational;
  densityText: string;
  densityNumber: number;
  source: "source" | "img";
  sourceIndex: number | null;
  sizesIndex: number | null;
  candidate: Candidate;
  adopted: AdoptedSource;
  discarded: DiscardedCandidate[];
  discardedAll: DiscardedCandidate[];
  candidateSet: CandidateSetReport;
  trace: SourceEvaluationTrace[];
}

export interface SelectionFailure {
  selected: null;
  reason:
    | "no-usable-candidate"
    | "img-candidate-set-unusable"
    | "no-img";
  detail: string;
  discardedAll: DiscardedCandidate[];
  trace: SourceEvaluationTrace[];
}

export type SelectPictureResult = PictureSelection | SelectionFailure;

interface DensityChoice {
  candidate: Candidate;
  density: Rational;
  slot: SlotWidthSelection | null;
}

function normalizeBaseUrl(baseUrl: string): string {
  try {
    return new URL(baseUrl).href;
  } catch {
    throw new TypeError(`baseUrl must be an absolute URL: ${baseUrl}`);
  }
}

function finalizeSet(
  candidates: Candidate[],
  discarded: DiscardedCandidate[],
  originalText: string,
): CandidateSetReport {
  let issue: CandidateSetIssue | null = null;
  if (candidates.length === 0) {
    issue = {
      reason: "empty-candidate-set",
      range: originalRange(originalText, 0, originalText.length),
      detail: "candidate set has no usable candidates",
    };
  } else {
    const hasWidth = candidates.some((candidate) => candidate.densityKind === "w");
    const hasDensity = candidates.some(
      (candidate) => candidate.densityKind === "x",
    );
    if (hasWidth && hasDensity) {
      issue = {
        reason: "mixed-descriptor-types",
        range: originalRange(originalText, 0, originalText.length),
        detail: "candidate set mixes w and x descriptors",
      };
    }
  }
  return { candidates, discarded, issue };
}

function toReport(parsed: ParsedSrcset): CandidateSetReport {
  return {
    candidates: parsed.candidates,
    discarded: parsed.discarded,
    issue: parsed.issue,
  };
}

function aggregateDiscarded(
  trace: readonly SourceEvaluationTrace[],
): DiscardedCandidate[] {
  return trace.flatMap((entry) => entry.candidateSet?.discarded ?? []);
}

function highResolutionCandidate(
  candidates: readonly Candidate[],
  targetDensity: Rational,
): Candidate {
  let bestAbove: Candidate | null = null;
  let bestAboveDensity: Rational | null = null;
  let maximum: Candidate | null = null;
  let maximumDensity: Rational | null = null;

  for (const candidate of candidates) {
    const density = candidate.densityValue;
    if (density.compare(targetDensity) >= 0) {
      if (bestAboveDensity === null || density.compare(bestAboveDensity) < 0) {
        bestAbove = candidate;
        bestAboveDensity = density;
      }
    }
    if (maximumDensity === null || density.compare(maximumDensity) > 0) {
      maximum = candidate;
      maximumDensity = density;
    }
  }

  return bestAbove ?? maximum!;
}

function chooseCandidate(
  candidates: readonly Candidate[],
  targetDensity: Rational,
): DensityChoice {
  const hasWidth = candidates.some((candidate) => candidate.densityKind === "w");
  const hasDensity = candidates.some(
    (candidate) => candidate.densityKind === "x",
  );
  if (hasWidth && hasDensity) {
    throw new TypeError("cannot choose from a mixed w/x candidate set");
  }

  if (!hasWidth) {
    const candidate = highResolutionCandidate(candidates, targetDensity);
    return {
      candidate,
      density: candidate.densityValue,
      slot: null,
    };
  }

  // The caller supplies the slot selection for w sets. This path is replaced
  // by chooseWidthCandidate below.
  throw new TypeError("width candidate set requires a slot width");
}

function chooseWidthCandidate(
  candidates: readonly Candidate[],
  targetDensity: Rational,
  slot: SlotWidthSelection,
): DensityChoice {
  let bestAbove: Candidate | null = null;
  let bestAboveDensity: Rational | null = null;
  let maximum: Candidate | null = null;
  let maximumDensity: Rational | null = null;

  for (const candidate of candidates) {
    const density = candidate.densityValue.divide(slot.slotWidth);
    if (density.compare(targetDensity) >= 0) {
      if (bestAboveDensity === null || density.compare(bestAboveDensity) < 0) {
        bestAbove = candidate;
        bestAboveDensity = density;
      }
    }
    if (maximumDensity === null || density.compare(maximumDensity) > 0) {
      maximum = candidate;
      maximumDensity = density;
    }
  }

  const chosen = bestAbove ?? maximum!;
  return {
    candidate: chosen,
    density: chosen.densityValue.divide(slot.slotWidth),
    slot,
  };
}

function buildSelected(
  choice: DensityChoice,
  adopted: AdoptedSource,
): SelectedCandidate {
  return {
    url: choice.candidate.url,
    density: choice.density,
    densityText: choice.density.toString(),
    densityNumber: choice.density.toNumber(),
    source: adopted.kind,
    sourceIndex: adopted.sourceIndex,
    sizesIndex: adopted.sizes?.index ?? null,
    densityKind: choice.candidate.densityKind,
    candidate: choice.candidate,
    slotWidth: choice.slot === null ? null : choice.slot.slotWidth,
    slotWidthNumber:
      choice.slot === null ? null : choice.slot.slotWidth.toNumber(),
    adopted,
    range: choice.candidate.range,
    raw: choice.candidate.raw,
  };
}

function mediaMatches(
  media: string | undefined,
  input: SelectPictureInput,
  context: MatchContext,
): boolean {
  if (media === undefined || media.trim() === "") {
    return true;
  }
  return input.mediaMatches(media, context);
}

function typeSupported(
  type: string | undefined,
  input: SelectPictureInput,
  context: MatchContext,
): boolean {
  if (type === undefined) {
    return true;
  }
  return input.supportsType(type, context);
}

/**
 * Reproduces the deterministic picture selection described by the task.
 * It never fetches resources; media and MIME support decisions are supplied by
 * host callbacks.
 */
export function selectPicture(input: SelectPictureInput): SelectPictureResult {
  const baseUrl = normalizeBaseUrl(input.baseUrl);
  const viewportWidth = Rational.from(input.viewportWidth);
  const dpr = Rational.from(input.dpr);
  if (!viewportWidth.isPositive()) {
    throw new TypeError("viewportWidth must be a positive rational");
  }
  if (!dpr.isPositive()) {
    throw new TypeError("dpr must be a positive rational");
  }

  const trace: SourceEvaluationTrace[] = [];
  const sources = input.sources ?? [];

  for (let sourceIndex = 0; sourceIndex < sources.length; sourceIndex += 1) {
    const source = sources[sourceIndex];
    const sourceContext: MatchContext = {
      kind: "source",
      sourceIndex,
      sizeIndex: null,
      baseUrl,
      viewportWidth,
      dpr,
    };
    const sourceMediaMatched = mediaMatches(source.media, input, sourceContext);
    const sourceTypeSupported = sourceMediaMatched
      ? typeSupported(source.type, input, sourceContext)
      : false;
    if (!sourceMediaMatched || !sourceTypeSupported) {
      trace.push({
        kind: "source",
        index: sourceIndex,
        media: source.media ?? null,
        type: source.type ?? null,
        mediaMatched: sourceMediaMatched,
        typeSupported: sourceTypeSupported,
        candidateSet: null,
      });
      continue;
    }

    const parsed = parseSrcset(source.srcset ?? "", baseUrl);
    const report = toReport(parsed);
    trace.push({
      kind: "source",
      index: sourceIndex,
      media: source.media ?? null,
      type: source.type ?? null,
      mediaMatched: true,
      typeSupported: true,
      candidateSet: report,
    });
    if (report.issue !== null || report.candidates.length === 0) {
      continue;
    }

    let choice: DensityChoice;
    if (report.candidates[0].densityKind === "w") {
      const slot = selectSlotWidth(
        source.sizes ?? [],
        viewportWidth,
        (media, sizeIndex) =>
          input.mediaMatches(media, {
            kind: "sizes",
            sourceIndex,
            sizeIndex,
            baseUrl,
            viewportWidth,
            dpr,
          }),
      );
      choice = chooseWidthCandidate(report.candidates, dpr, slot);
    } else {
      choice = chooseCandidate(report.candidates, dpr);
    }

    const adopted: AdoptedSource = {
      kind: "source",
      sourceIndex,
      media: source.media ?? null,
      type: source.type ?? null,
      sizes:
        choice.slot === null
          ? null
          : {
              index: choice.slot.entryIndex,
              media: choice.slot.entry?.media ?? null,
              expression: choice.slot.entry?.expression ?? null,
              slotWidth: choice.slot.slotWidth,
              slotWidthNumber: choice.slot.slotWidth.toNumber(),
              usedViewportFallback: choice.slot.usedViewportFallback,
            },
    };
    const selected = buildSelected(choice, adopted);

    return {
      selected,
      url: selected.url,
      density: selected.density,
      densityText: selected.densityText,
      densityNumber: selected.densityNumber,
      source: "source",
      sourceIndex,
      sizesIndex: adopted.sizes?.index ?? null,
      candidate: selected.candidate,
      adopted,
      discarded: report.discarded,
      discardedAll: aggregateDiscarded(trace),
      candidateSet: report,
      trace,
    };
  }

  if (!input.img) {
    return {
      selected: null,
      reason: "no-img",
      detail: "no source produced a usable candidate set and no img was supplied",
      discardedAll: aggregateDiscarded(trace),
      trace,
    };
  }

  const img = input.img;
  const parsedImg = parseSrcset(img.srcset ?? "", baseUrl);
  const candidates = [...parsedImg.candidates];
  const discarded = [...parsedImg.discarded];
  let issue = parsedImg.issue;

  // The src fallback is an img-only rule. It applies when the valid set has
  // neither a width descriptor nor a 1x descriptor.
  const hasWidth = candidates.some((candidate) => candidate.densityKind === "w");
  const hasOneX = candidates.some(
    (candidate) =>
      candidate.densityKind === "x" &&
      candidate.densityValue.equals(new Rational(1n)),
  );
  if (issue?.reason !== "mixed-descriptor-types" && !hasWidth && !hasOneX) {
    if ((img.src ?? "").trim() !== "") {
      const srcResult = parseSrcCandidate(img.src!, baseUrl);
      if (srcResult.candidate !== null) {
        const candidate = {
          ...srcResult.candidate,
          index: candidates.length,
        };
        candidates.push(candidate);
      }
      if (srcResult.discarded !== null) {
        discarded.push(srcResult.discarded);
      }
    }
  }

  const imgReport = finalizeSet(candidates, discarded, img.srcset ?? "");
  issue = imgReport.issue;
  trace.push({
    kind: "img",
    index: null,
    media: null,
    type: null,
    mediaMatched: true,
    typeSupported: true,
    candidateSet: imgReport,
  });

  if (issue !== null || candidates.length === 0) {
    return {
      selected: null,
      reason: "img-candidate-set-unusable",
      detail:
        issue?.reason === "mixed-descriptor-types"
          ? "img srcset mixes w and x descriptors"
          : "img produced no usable candidate",
      discardedAll: aggregateDiscarded(trace),
      trace,
    };
  }

  let choice: DensityChoice;
  if (candidates[0].densityKind === "w") {
    const slot = selectSlotWidth(
      img.sizes ?? [],
      viewportWidth,
      (media, sizeIndex) =>
        input.mediaMatches(media, {
          kind: "sizes",
          sourceIndex: null,
          sizeIndex,
          baseUrl,
          viewportWidth,
          dpr,
        }),
    );
    choice = chooseWidthCandidate(candidates, dpr, slot);
  } else {
    choice = chooseCandidate(candidates, dpr);
  }

  const adopted: AdoptedSource = {
    kind: "img",
    sourceIndex: null,
    media: null,
    type: null,
    sizes:
      choice.slot === null
        ? null
        : {
            index: choice.slot.entryIndex,
            media: choice.slot.entry?.media ?? null,
            expression: choice.slot.entry?.expression ?? null,
            slotWidth: choice.slot.slotWidth,
            slotWidthNumber: choice.slot.slotWidth.toNumber(),
            usedViewportFallback: choice.slot.usedViewportFallback,
          },
  };
  const selected = buildSelected(choice, adopted);

  return {
    selected,
    url: selected.url,
    density: selected.density,
    densityText: selected.densityText,
    densityNumber: selected.densityNumber,
    source: "img",
    sourceIndex: null,
    sizesIndex: adopted.sizes?.index ?? null,
    candidate: selected.candidate,
    adopted,
    discarded: imgReport.discarded,
    discardedAll: aggregateDiscarded(trace),
    candidateSet: imgReport,
    trace,
  };
}

export const selectImageCandidate = selectPicture;
