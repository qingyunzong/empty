import { Rational } from "./rational.js";

export type DescriptorKind = "w" | "x";

export interface OriginalRange {
  /** Half-open UTF-16 code-unit offset in the original attribute string. */
  start: number;
  /** Half-open UTF-16 code-unit offset in the original attribute string. */
  end: number;
  /** Half-open UTF-8 byte offset in the original attribute string. */
  byteStart: number;
  /** Half-open UTF-8 byte offset in the original attribute string. */
  byteEnd: number;
}

export interface DensityDescriptor {
  kind: DescriptorKind;
  /** The descriptor value itself (a width for w, a density for x). */
  value: Rational;
  /** The exact descriptor token, for example "2x" or "640w". */
  text: string;
}

export interface Candidate {
  /** Position in the usable, de-duplicated candidate list. */
  index: number;
  origin: "srcset" | "src";
  /** Canonical URL after resolution against the supplied absolute base URL. */
  url: string;
  /** URL text as found in the attribute (trailing commas already removed). */
  urlRaw: string;
  /** The candidate's original text, excluding the separating comma. */
  raw: string;
  range: OriginalRange;
  descriptor: DensityDescriptor;
  /** w for width descriptors, x for density descriptors. */
  densityKind: DescriptorKind;
  /** The descriptor's rational value before slot-width conversion. */
  densityValue: Rational;
}

export type DiscardReason =
  | "empty-url"
  | "invalid-url"
  | "multiple-descriptors"
  | "unsupported-descriptor"
  | "invalid-width-descriptor"
  | "invalid-density-descriptor"
  | "non-positive-descriptor"
  | "duplicate-descriptor";

export interface DiscardedCandidate {
  origin: "srcset" | "src";
  raw: string;
  range: OriginalRange;
  reason: DiscardReason;
  detail: string;
}

export interface CandidateSetIssue {
  reason: "empty-candidate-set" | "mixed-descriptor-types";
  range: OriginalRange;
  detail: string;
}

export interface ParsedSrcset {
  candidates: Candidate[];
  discarded: DiscardedCandidate[];
  issue: CandidateSetIssue | null;
}

interface RawCandidate {
  urlRaw: string;
  descriptorText: string | null;
  rangeStart: number;
  rangeEnd: number;
}

interface DescriptorParseFailure {
  reason: DiscardReason;
  detail: string;
}

type DescriptorParseResult =
  | { ok: true; descriptor: DensityDescriptor }
  | { ok: false; failure: DescriptorParseFailure };

const ASCII_WHITESPACE = /[\t\n\f\r ]/;
const encoder = new TextEncoder();

function isAsciiWhitespace(character: string): boolean {
  return ASCII_WHITESPACE.test(character);
}

function isComma(character: string): boolean {
  return character === ",";
}

function utf8Length(value: string): number {
  return encoder.encode(value).length;
}

export function originalRange(text: string, start: number, end: number): OriginalRange {
  return {
    start,
    end,
    byteStart: utf8Length(text.slice(0, start)),
    byteEnd: utf8Length(text.slice(0, end)),
  };
}

function trimTrailingCommas(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === ",") {
    end -= 1;
  }
  return value.slice(0, end);
}

function trimAsciiWhitespace(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && isAsciiWhitespace(value[start])) {
    start += 1;
  }
  while (end > start && isAsciiWhitespace(value[end - 1])) {
    end -= 1;
  }
  return value.slice(start, end);
}

function parseDescriptorToken(token: string): DescriptorParseResult {
  if (token.endsWith("w")) {
    const numberText = token.slice(0, -1);
    if (!/^\d+$/.test(numberText)) {
      return {
        ok: false,
        failure: {
          reason: "invalid-width-descriptor",
          detail: `w descriptor must be an unsigned positive decimal integer: ${token}`,
        },
      };
    }
    const value = new Rational(BigInt(numberText));
    if (!value.isPositive()) {
      return {
        ok: false,
        failure: {
          reason: "non-positive-descriptor",
          detail: `w descriptor must be positive: ${token}`,
        },
      };
    }
    return { ok: true, descriptor: { kind: "w", value, text: token } };
  }

  if (token.endsWith("x")) {
    const numberText = token.slice(0, -1);
    const value = Rational.fromUnsignedDecimal(numberText);
    if (value === null) {
      return {
        ok: false,
        failure: {
          reason: "invalid-density-descriptor",
          detail:
            `x descriptor must be an unsigned finite decimal without an exponent: ${token}`,
        },
      };
    }
    if (!value.isPositive()) {
      return {
        ok: false,
        failure: {
          reason: "non-positive-descriptor",
          detail: `x descriptor must be positive: ${token}`,
        },
      };
    }
    return { ok: true, descriptor: { kind: "x", value, text: token } };
  }

  return {
    ok: false,
    failure: {
      reason: "unsupported-descriptor",
      detail: `unsupported descriptor: ${token}`,
    },
  };
}

/**
 * Scans srcset using the specified URL/comma rules. This does not split on
 * commas inside a URL. Each candidate keeps both UTF-16 offsets and UTF-8
 * byte offsets into the original srcset string.
 */
function scanSrcset(srcset: string): RawCandidate[] {
  const rawCandidates: RawCandidate[] = [];
  let cursor = 0;

  while (cursor < srcset.length) {
    while (
      cursor < srcset.length &&
      (isAsciiWhitespace(srcset[cursor]) || isComma(srcset[cursor]))
    ) {
      cursor += 1;
    }
    if (cursor >= srcset.length) {
      break;
    }

    const candidateStart = cursor;
    let urlEnd = cursor;
    while (urlEnd < srcset.length && !isAsciiWhitespace(srcset[urlEnd])) {
      urlEnd += 1;
    }
    const urlToken = srcset.slice(candidateStart, urlEnd);

    // A URL token ending in a comma has no descriptors. All of its trailing
    // commas are part of the candidate's original range but not of the URL.
    if (urlToken.endsWith(",")) {
      rawCandidates.push({
        urlRaw: trimTrailingCommas(urlToken),
        descriptorText: null,
        rangeStart: candidateStart,
        rangeEnd: urlEnd,
      });
      cursor = urlEnd;
      continue;
    }

    let descriptorStart = urlEnd;
    while (
      descriptorStart < srcset.length &&
      isAsciiWhitespace(srcset[descriptorStart])
    ) {
      descriptorStart += 1;
    }

    if (
      descriptorStart >= srcset.length ||
      isComma(srcset[descriptorStart])
    ) {
      rawCandidates.push({
        urlRaw: urlToken,
        descriptorText: null,
        rangeStart: candidateStart,
        rangeEnd: urlEnd,
      });
      cursor =
        descriptorStart < srcset.length ? descriptorStart + 1 : srcset.length;
      continue;
    }

    let descriptorEnd = descriptorStart;
    while (
      descriptorEnd < srcset.length &&
      !isComma(srcset[descriptorEnd])
    ) {
      descriptorEnd += 1;
    }

    let meaningfulEnd = descriptorEnd;
    while (
      meaningfulEnd > descriptorStart &&
      isAsciiWhitespace(srcset[meaningfulEnd - 1])
    ) {
      meaningfulEnd -= 1;
    }

    rawCandidates.push({
      urlRaw: urlToken,
      descriptorText: srcset.slice(descriptorStart, meaningfulEnd),
      rangeStart: candidateStart,
      rangeEnd: meaningfulEnd,
    });
    cursor =
      descriptorEnd < srcset.length ? descriptorEnd + 1 : srcset.length;
  }

  return rawCandidates;
}

function splitDescriptorText(text: string): string[] {
  const trimmed = trimAsciiWhitespace(text);
  if (trimmed === "") {
    return [];
  }
  return trimmed.split(/[\t\n\f\r ]+/);
}

function resolveUrl(urlRaw: string, baseUrl: string): string | null {
  try {
    return new URL(urlRaw, baseUrl).href;
  } catch {
    return null;
  }
}

function deduplicate(
  candidates: Candidate[],
  discarded: DiscardedCandidate[],
): Candidate[] {
  const kept: Candidate[] = [];
  const seen = new Map<string, Candidate>();

  for (const candidate of candidates) {
    const key = `${candidate.densityKind}:${candidate.densityValue.toString()}`;
    const previous = seen.get(key);
    if (previous !== undefined) {
      discarded.push({
        origin: candidate.origin,
        raw: candidate.raw,
        range: candidate.range,
        reason: "duplicate-descriptor",
        detail: `duplicate ${candidate.descriptor.text}; keeping the earlier ${previous.descriptor.text}`,
      });
      continue;
    }
    seen.set(key, candidate);
    kept.push(candidate);
  }

  return kept.map((candidate, index) => ({ ...candidate, index }));
}

export function parseSrcset(srcset: string, baseUrl: string): ParsedSrcset {
  const candidates: Candidate[] = [];
  const discarded: DiscardedCandidate[] = [];

  for (const raw of scanSrcset(srcset)) {
    const range = originalRange(srcset, raw.rangeStart, raw.rangeEnd);
    const rawText = srcset.slice(raw.rangeStart, raw.rangeEnd);

    if (raw.urlRaw === "") {
      discarded.push({
        origin: "srcset",
        raw: rawText,
        range,
        reason: "empty-url",
        detail: "candidate URL is empty",
      });
      continue;
    }

    let descriptor: DensityDescriptor;
    if (raw.descriptorText === null) {
      descriptor = {
        kind: "x",
        value: new Rational(1n),
        text: "1x",
      };
    } else {
      const tokens = splitDescriptorText(raw.descriptorText);
      if (tokens.length !== 1) {
        discarded.push({
          origin: "srcset",
          raw: rawText,
          range,
          reason: "multiple-descriptors",
          detail:
            tokens.length === 0
              ? "expected a descriptor"
              : `expected one descriptor, found ${tokens.length}`,
        });
        continue;
      }
      const parsed = parseDescriptorToken(tokens[0]);
      if (!parsed.ok) {
        discarded.push({
          origin: "srcset",
          raw: rawText,
          range,
          reason: parsed.failure.reason,
          detail: parsed.failure.detail,
        });
        continue;
      }
      descriptor = parsed.descriptor;
    }

    const canonicalUrl = resolveUrl(raw.urlRaw, baseUrl);
    if (canonicalUrl === null) {
      discarded.push({
        origin: "srcset",
        raw: rawText,
        range,
        reason: "invalid-url",
        detail: `cannot resolve URL against base: ${raw.urlRaw}`,
      });
      continue;
    }

    candidates.push({
      index: candidates.length,
      origin: "srcset",
      url: canonicalUrl,
      urlRaw: raw.urlRaw,
      raw: rawText,
      range,
      descriptor,
      densityKind: descriptor.kind,
      densityValue: descriptor.value,
    });
  }

  const deduplicated = deduplicate(candidates, discarded);
  let issue: CandidateSetIssue | null = null;
  if (deduplicated.length === 0) {
    issue = {
      reason: "empty-candidate-set",
      range: originalRange(srcset, 0, srcset.length),
      detail: "candidate set has no usable candidates",
    };
  } else {
    const hasWidth = deduplicated.some((candidate) => candidate.densityKind === "w");
    const hasDensity = deduplicated.some(
      (candidate) => candidate.densityKind === "x",
    );
    if (hasWidth && hasDensity) {
      issue = {
        reason: "mixed-descriptor-types",
        range: originalRange(srcset, 0, srcset.length),
        detail: "candidate set mixes w and x descriptors",
      };
    }
  }

  return { candidates: deduplicated, discarded, issue };
}

export interface SrcCandidateResult {
  candidate: Candidate | null;
  discarded: DiscardedCandidate | null;
}

/**
 * Builds the 1x candidate used when an img's srcset has neither w descriptors
 * nor a 1x descriptor. The range is relative to the src attribute itself.
 */
export function parseSrcCandidate(src: string, baseUrl: string): SrcCandidateResult {
  const range = originalRange(src, 0, src.length);
  if (src.trim() === "") {
    return {
      candidate: null,
      discarded: {
        origin: "src",
        raw: src,
        range,
        reason: "empty-url",
        detail: "img src is empty",
      },
    };
  }

  const canonicalUrl = resolveUrl(src, baseUrl);
  if (canonicalUrl === null) {
    return {
      candidate: null,
      discarded: {
        origin: "src",
        raw: src,
        range,
        reason: "invalid-url",
        detail: `cannot resolve img src against base: ${src}`,
      },
    };
  }

  const descriptor: DensityDescriptor = {
    kind: "x",
    value: new Rational(1n),
    text: "1x",
  };
  return {
    candidate: {
      index: 0,
      origin: "src",
      url: canonicalUrl,
      urlRaw: src,
      raw: src,
      range,
      descriptor,
      densityKind: "x",
      densityValue: descriptor.value,
    },
    discarded: null,
  };
}
