import { findLink, parseLinkHeader } from './link-header.ts';

export interface Page<T = unknown> {
  /** Normalized URL the page was fetched from. */
  readonly url: string;
  readonly body: T;
}

export interface FetchResponse<T = unknown> {
  readonly body: T;
  /** Raw value of the Link response header, if any. */
  readonly linkHeader?: string | null;
}

export interface Checkpoint {
  /** Resume point: the normalized next URL, or null when pagination finished. */
  readonly nextUrl: string | null;
  /** Number of pages persisted so far in this run. */
  readonly pagesCompleted: number;
}

export interface CheckpointStore {
  commit(checkpoint: Checkpoint): void | Promise<void>;
}

export interface PaginateOptions<T = unknown> {
  /** Initial URL (absolute, or relative to nothing - must be absolute in practice). */
  readonly startUrl: string;
  readonly fetchPage: (url: string) => Promise<FetchResponse<T>>;
  /** Persists one page; must resolve only after the page is durably stored. */
  readonly sink: (page: Page<T>) => Promise<void>;
  /** Extra origins (besides the start URL's origin) that next links may point to. */
  readonly allowedOrigins?: readonly string[];
  /** Receives the next-link resume point after each page is persisted. */
  readonly checkpointStore?: CheckpointStore;
  /** Resume point from a previous run; takes precedence over startUrl. */
  readonly resumeFrom?: string | null;
  /** Safety cap on fetched pages. */
  readonly maxPages?: number;
}

export type PaginateStatus = 'completed' | 'cycle-detected' | 'max-pages-reached';

export interface PaginateResult {
  /** Normalized URLs of every persisted page, in visit order. */
  readonly path: readonly string[];
  readonly status: PaginateStatus;
  /** Last committed resume point (null when the run completed). */
  readonly resumeFrom: string | null;
}

export class CrossOriginNextError extends Error {
  readonly nextUrl: string;
  readonly origin: string;

  constructor(nextUrl: string, origin: string) {
    super(`refused cross-origin next link: ${nextUrl} (origin ${origin} is not whitelisted)`);
    this.name = 'CrossOriginNextError';
    this.nextUrl = nextUrl;
    this.origin = origin;
  }
}

/**
 * Resolve a (possibly relative) URI-reference against a base URL and
 * normalize it: lowercase scheme/host, drop default ports, drop the
 * fragment, and resolve dot segments (all via the WHATWG URL algorithm).
 */
export function normalizeUrl(reference: string, base: string): string {
  const url = new URL(reference, base);
  url.hash = '';
  return url.toString();
}

function normalizeOrigin(origin: string): string {
  return new URL(origin).origin;
}

/**
 * Follow rel="next" links from startUrl (or resumeFrom), persisting each
 * page before committing the resume point for the following link.
 *
 * Per iteration the order is: fetch -> parse/validate next -> sink (awaited)
 * -> checkpoint commit. A checkpoint is therefore never committed for a page
 * that has not been confirmed persisted, and a next URL that fails the
 * origin whitelist or closes a cycle is never committed as a resume point.
 */
export async function paginate<T>(options: PaginateOptions<T>): Promise<PaginateResult> {
  const start = normalizeUrl(options.resumeFrom ?? options.startUrl, options.startUrl);
  const allowedOrigins = new Set<string>([
    normalizeOrigin(options.startUrl),
    ...(options.allowedOrigins ?? []).map(normalizeOrigin),
  ]);
  if (!allowedOrigins.has(new URL(start).origin)) {
    throw new CrossOriginNextError(start, new URL(start).origin);
  }

  const visited = new Set<string>();
  const path: string[] = [];
  let current: string | null = start;
  let pagesCompleted = 0;

  while (current !== null) {
    if (options.maxPages !== undefined && pagesCompleted >= options.maxPages) {
      return { path, status: 'max-pages-reached', resumeFrom: current };
    }
    visited.add(current);

    const response = await options.fetchPage(current);
    const entries = response.linkHeader ? parseLinkHeader(response.linkHeader) : [];
    const nextEntry = findLink(entries, 'next');

    let next: string | null = null;
    let cycle = false;
    if (nextEntry) {
      const candidate = normalizeUrl(nextEntry.target, current);
      const origin = new URL(candidate).origin;
      if (!allowedOrigins.has(origin)) {
        throw new CrossOriginNextError(candidate, origin);
      }
      if (visited.has(candidate)) {
        cycle = true;
      } else {
        next = candidate;
      }
    }

    // Persist first; only after the sink confirms do we commit the resume
    // point for the next link.
    await options.sink({ url: current, body: response.body });
    pagesCompleted++;
    path.push(current);

    const checkpoint: Checkpoint = { nextUrl: next, pagesCompleted };
    await options.checkpointStore?.commit(checkpoint);

    if (cycle) {
      return { path, status: 'cycle-detected', resumeFrom: null };
    }
    current = next;
  }

  return { path, status: 'completed', resumeFrom: null };
}
