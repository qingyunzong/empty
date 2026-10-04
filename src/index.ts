import { createHash, randomUUID } from "node:crypto";

export interface DocInput {
  id: string;
  text: string;
}

export interface Hit {
  id: string;
  score: number;
}

export interface SearchOptions {
  /** Page size. Must be a positive integer. */
  limit: number;
  /** Opaque cursor returned by a previous page of the same query. */
  cursor?: string;
  /**
   * Maximum number of documents this request is allowed to evaluate.
   * Defaults to Infinity (scan the whole index).
   */
  budget?: number;
}

export type IncompleteReason = "budget_exhausted";

export interface Page {
  hits: Hit[];
  /** Pass back as `cursor` to fetch the next page; null when no more pages. */
  nextCursor: string | null;
  /**
   * false ("not closed") when the scan budget ran out before every document
   * was evaluated. In that case the page may be missing higher-scoring
   * documents that were never inspected; they are NOT silently skipped —
   * the caller is told via this flag and `incompleteReason`.
   */
  complete: boolean;
  incompleteReason: IncompleteReason | null;
  /** Documents actually evaluated in this request. */
  scanned: number;
  /** Documents in the index at the time of the request. */
  total: number;
  indexVersion: number;
  queryDigest: string;
}

export class InvalidCursorError extends Error {
  constructor(message = "cursor is malformed") {
    super(message);
    this.name = "InvalidCursorError";
  }
}

export class StaleCursorError extends Error {
  constructor(message = "cursor was issued by a different index version") {
    super(message);
    this.name = "StaleCursorError";
  }
}

export class CursorQueryMismatchError extends Error {
  constructor(message = "cursor was issued for a different query") {
    super(message);
    this.name = "CursorQueryMismatchError";
  }
}

/** Canonical form used for both matching and the query digest. */
export function normalizeQuery(query: string): string {
  return query.trim().toLowerCase().split(/\s+/).filter(Boolean).join(" ");
}

export function queryTerms(query: string): string[] {
  const normalized = normalizeQuery(query);
  return normalized === "" ? [] : normalized.split(" ");
}

export function queryDigest(query: string): string {
  return createHash("sha256").update(normalizeQuery(query), "utf8").digest("hex");
}

/** Deterministic scorer: total occurrences of query terms in the text. */
export function scoreDocument(text: string, terms: string[]): number {
  const haystack = text.toLowerCase();
  let score = 0;
  for (const term of terms) {
    let from = 0;
    for (;;) {
      const at = haystack.indexOf(term, from);
      if (at === -1) break;
      score += 1;
      from = at + term.length;
    }
  }
  return score;
}

/** Total order: score descending, then id ascending. Deterministic and stable. */
export function compareHits(a: Hit, b: Hit): number {
  if (a.score !== b.score) return b.score - a.score;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

interface CursorKey {
  s: number;
  id: string;
}

interface CursorPayload {
  /** Index instance id — a cursor is meaningless across instances. */
  i: string;
  /** Index version at issue time. */
  v: number;
  /** Digest of the normalized query. */
  q: string;
  /** Key of the last hit of the previous page. */
  k: CursorKey;
}

export function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

export function decodeCursor(cursor: string): CursorPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new InvalidCursorError();
  }
  const p = parsed as Partial<CursorPayload> | null;
  if (
    p === null ||
    typeof p !== "object" ||
    typeof p.i !== "string" ||
    typeof p.v !== "number" ||
    typeof p.q !== "string" ||
    p.k === null ||
    typeof p.k !== "object" ||
    typeof (p.k as CursorKey).s !== "number" ||
    typeof (p.k as CursorKey).id !== "string"
  ) {
    throw new InvalidCursorError();
  }
  return p as CursorPayload;
}

export class SearchIndex {
  private readonly docs = new Map<string, string>();
  readonly indexId: string = randomUUID();
  private version = 0;

  constructor(docs: DocInput[] = []) {
    for (const doc of docs) this.add(doc);
  }

  get indexVersion(): number {
    return this.version;
  }

  get size(): number {
    return this.docs.size;
  }

  add(doc: DocInput): void {
    this.docs.set(doc.id, doc.text);
    this.version += 1;
  }

  update(id: string, text: string): void {
    if (!this.docs.has(id)) throw new Error(`unknown document id: ${id}`);
    this.docs.set(id, text);
    this.version += 1;
  }

  remove(id: string): void {
    if (this.docs.delete(id)) this.version += 1;
  }

  search(query: string, options: SearchOptions): Page {
    const { limit, cursor, budget = Infinity } = options;
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new RangeError("limit must be a positive integer");
    }
    if (!(budget > 0)) {
      throw new RangeError("budget must be positive");
    }

    const digest = queryDigest(query);
    let afterKey: CursorKey | null = null;
    if (cursor !== undefined) {
      const payload = decodeCursor(cursor);
      if (payload.i !== this.indexId || payload.v !== this.version) {
        throw new StaleCursorError(
          `cursor bound to index ${payload.i}@v${payload.v}, current is ${this.indexId}@v${this.version}`
        );
      }
      if (payload.q !== digest) {
        throw new CursorQueryMismatchError();
      }
      afterKey = payload.k;
    }

    const terms = queryTerms(query);
    const matched: Hit[] = [];
    let scanned = 0;
    let exhausted = false;

    for (const [id, text] of this.docs) {
      if (scanned >= budget) {
        exhausted = true;
        break;
      }
      scanned += 1;
      const score = scoreDocument(text, terms);
      if (score <= 0) continue;
      const hit: Hit = { id, score };
      if (afterKey !== null && compareHits(hit, { id: afterKey.id, score: afterKey.s }) <= 0) {
        continue;
      }
      matched.push(hit);
    }

    matched.sort(compareHits);
    const hits = matched.slice(0, limit);
    const moreEvaluated = matched.length > limit;
    const last = hits[hits.length - 1];

    const nextCursor =
      last !== undefined && (moreEvaluated || exhausted)
        ? encodeCursor({
            i: this.indexId,
            v: this.version,
            q: digest,
            k: { s: last.score, id: last.id },
          })
        : null;

    return {
      hits,
      nextCursor,
      complete: !exhausted,
      incompleteReason: exhausted ? "budget_exhausted" : null,
      scanned,
      total: this.docs.size,
      indexVersion: this.version,
      queryDigest: digest,
    };
  }

  /**
   * Independent reference implementation: evaluates every document and
   * returns the full sorted result set. Used to cross-check paginated
   * output (union and order) in tests.
   */
  fullScan(query: string): Hit[] {
    const terms = queryTerms(query);
    const all: Hit[] = [];
    for (const [id, text] of this.docs) {
      const score = scoreDocument(text, terms);
      if (score > 0) all.push({ id, score });
    }
    all.sort(compareHits);
    return all;
  }
}
