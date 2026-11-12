import {
  Rational,
  selectPicture,
  type ImgInput,
  type MatchContext,
  type SelectPictureResult,
  type SourceInput,
} from "../index.js";

/**
 * A deterministic host adapter for a captured <picture> tree.
 *
 * Real hosts can replace the two matcher functions with their own media-query
 * and MIME registry. The important point is that selection itself never fetches
 * a resource and never asks the browser to guess.
 */
export interface HostPictureSnapshot {
  sources: SourceInput[];
  img: ImgInput;
  baseUrl: string;
  viewportWidth: Rational;
  dpr: Rational;
  supportedMimeTypes: readonly string[];
}

export function mediaQueryMatches(
  media: string,
  viewportWidth: Rational,
): boolean {
  const query = media.trim();
  if (query === "") {
    return true;
  }

  const widthTerms: Array<{ operator: "min" | "max"; width: Rational }> = [];
  const widthPattern =
    /\(\s*(min|max)-width\s*:\s*(\d+(?:\.\d+)?)px\s*\)/gi;
  for (const match of query.matchAll(widthPattern)) {
    widthTerms.push({
      operator: match[1].toLowerCase() as "min" | "max",
      width: Rational.from(match[2]),
    });
  }

  if (widthTerms.length === 0) {
    // A captured host should make unsupported conditions deterministic rather
    // than accidentally treating them as matches.
    return false;
  }

  return widthTerms.every(({ operator, width }) =>
    operator === "min"
      ? viewportWidth.compare(width) >= 0
      : viewportWidth.compare(width) <= 0,
  );
}

export function makeHostCallbacks(snapshot: HostPictureSnapshot): {
  mediaMatches: (media: string, context: MatchContext) => boolean;
  supportsType: (type: string, context: MatchContext) => boolean;
} {
  const supported = new Set(
    snapshot.supportedMimeTypes.map((type) => type.toLowerCase()),
  );
  return {
    mediaMatches: (media, context) =>
      mediaQueryMatches(media, context.viewportWidth),
    supportsType: (type) => supported.has(type.toLowerCase()),
  };
}

export function selectHostPicture(
  snapshot: HostPictureSnapshot,
): SelectPictureResult {
  const callbacks = makeHostCallbacks(snapshot);
  return selectPicture({
    sources: snapshot.sources,
    img: snapshot.img,
    baseUrl: snapshot.baseUrl,
    viewportWidth: snapshot.viewportWidth,
    dpr: snapshot.dpr,
    ...callbacks,
  });
}
