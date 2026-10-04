import { digest, getAtPath, pathKey, type JsonValue } from "./json.js";

/** Which side's value a resolution picks, or an explicit custom value. */
export type Choice =
  | { kind: "ours" }
  | { kind: "theirs" }
  | { kind: "base" }
  | { kind: "custom"; value: JsonValue };

/**
 * A resolution choice bound to the digests of BOTH sides' source values
 * (and the base value, for provenance) at the moment it was made.
 * It stays valid only while the sources at `path` still match those digests.
 */
export interface Resolution {
  /** Field path the conflict is at, e.g. ["profile", "name"]. */
  path: string[];
  choice: Choice;
  baseDigest: string;
  oursDigest: string;
  theirsDigest: string;
}

export type StaleReason = "ours-changed" | "theirs-changed" | "both-changed";

/**
 * Bind a choice for `path` to the current sources. Digests are taken from
 * the values at `path` in base/ours/theirs right now.
 */
export function makeResolution(
  path: string[],
  choice: Choice,
  sources: { base: JsonValue; ours: JsonValue; theirs: JsonValue },
): Resolution {
  return {
    path: [...path],
    choice,
    baseDigest: digest(getAtPath(sources.base, path)),
    oursDigest: digest(getAtPath(sources.ours, path)),
    theirsDigest: digest(getAtPath(sources.theirs, path)),
  };
}

export interface MatchResult {
  matches: boolean;
  staleReason?: StaleReason;
}

/**
 * Check a stored resolution against the current sources. It matches only if
 * BOTH sides' values at the path still hash to the bound digests.
 */
export function matchResolution(
  res: Resolution,
  sources: { ours: JsonValue; theirs: JsonValue },
): MatchResult {
  const oursNow = digest(getAtPath(sources.ours, res.path));
  const theirsNow = digest(getAtPath(sources.theirs, res.path));
  const oursStale = oursNow !== res.oursDigest;
  const theirsStale = theirsNow !== res.theirsDigest;
  if (!oursStale && !theirsStale) return { matches: true };
  const staleReason: StaleReason =
    oursStale && theirsStale ? "both-changed" : oursStale ? "ours-changed" : "theirs-changed";
  return { matches: false, staleReason };
}

/** Resolve the choice to a concrete value given the current sources. */
export function pickValue(
  choice: Choice,
  sources: { base: JsonValue; ours: JsonValue; theirs: JsonValue },
  path: string[],
): JsonValue {
  switch (choice.kind) {
    case "ours":
      return getAtPath(sources.ours, path) as JsonValue;
    case "theirs":
      return getAtPath(sources.theirs, path) as JsonValue;
    case "base":
      return getAtPath(sources.base, path) as JsonValue;
    case "custom":
      return choice.value;
  }
}

/** Index resolutions by field path; later entries win on duplicates. */
export function indexResolutions(resolutions: Resolution[]): Map<string, Resolution> {
  const map = new Map<string, Resolution>();
  for (const res of resolutions) map.set(pathKey(res.path), res);
  return map;
}
