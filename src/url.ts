import type { RedirectHop, UrlMatch } from "./types.ts";

export interface UrlParts {
  href: string;
  origin: string;
  protocol: string;
  host: string;
  pathname: string;
  search: string;
}

export function tryUrl(input: string, base?: string): URL | undefined {
  try {
    return new URL(input, base);
  } catch {
    return undefined;
  }
}

/**
 * Canonical form used for attribution. Fragments never identify a resource
 * request and are removed. Query order is deliberately preserved because
 * signed download URLs can be order-sensitive.
 */
export function normalizeUrl(input: string, base?: string): string {
  const url = tryUrl(input, base);
  if (!url) {
    return input.trim();
  }
  url.hash = "";
  return url.toString();
}

export function urlParts(input: string, base?: string): UrlParts | undefined {
  const url = tryUrl(input, base);
  if (!url) {
    return undefined;
  }
  return {
    href: normalizeUrl(input, base),
    origin: url.origin,
    protocol: url.protocol,
    host: url.host,
    pathname: url.pathname,
    search: url.search,
  };
}

export function matchUrl(
  target: string,
  candidate: string,
  options: { allowQueryless?: boolean; base?: string } = {},
): UrlMatch | undefined {
  const targetUrl = tryUrl(target, options.base);
  const candidateUrl = tryUrl(candidate, options.base);

  if (!targetUrl || !candidateUrl) {
    const left = target.trim().replace(/#.*$/, "");
    const right = candidate.trim().replace(/#.*$/, "");
    if (left === right) {
      return { kind: "exact", target: left, candidate: right, score: 26 };
    }
    return undefined;
  }

  targetUrl.hash = "";
  candidateUrl.hash = "";

  if (targetUrl.href === candidateUrl.href) {
    return {
      kind: "exact",
      target: targetUrl.href,
      candidate: candidateUrl.href,
      score: 30,
    };
  }

  if (
    options.allowQueryless !== false &&
    targetUrl.origin === candidateUrl.origin &&
    targetUrl.pathname === candidateUrl.pathname
  ) {
    return {
      kind: "origin-path",
      target: targetUrl.href,
      candidate: candidateUrl.href,
      score: 20,
    };
  }

  return undefined;
}

export function uniqueUrls(
  urls: readonly (string | undefined | null)[],
  base?: string,
): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of urls) {
    if (!value) {
      continue;
    }
    const normalized = normalizeUrl(value, base);
    if (!seen.has(normalized)) {
      seen.add(normalized);
      result.push(normalized);
    }
  }
  return result;
}

export function bestUrlMatch(
  targets: readonly string[],
  candidates: readonly string[],
  options: { allowQueryless?: boolean } = {},
): UrlMatch | undefined {
  let best: UrlMatch | undefined;
  for (const target of targets) {
    for (const candidate of candidates) {
      const match = matchUrl(target, candidate, options);
      if (match && (!best || match.score > best.score)) {
        best = match;
      }
    }
  }
  return best;
}

export function firstHopAt(
  chain: readonly RedirectHop[],
): number | undefined {
  const first = chain.find((hop) => Number.isFinite(hop.at));
  return first?.at;
}

export function basename(path: string): string {
  const lastSlash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return lastSlash >= 0 ? path.slice(lastSlash + 1) : path;
}
