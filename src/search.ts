import { createHash } from "node:crypto";

export interface Doc {
  id: string;
  text: string;
}

export interface Query {
  term: string;
}

export interface Hit {
  id: string;
  score: number;
}

export interface SearchOptions {
  limit: number;
  budget?: number;
  cursor?: string;
}

export interface SearchResult {
  items: Hit[];
  nextCursor: string | null;
  closed: boolean;
  scanned: number;
}

export class CursorError extends Error {}
export class MalformedCursorError extends CursorError {}
export class StaleCursorError extends CursorError {}
export class QueryMismatchError extends CursorError {}

interface Keyset {
  score: number;
  id: string;
}

interface CursorPayload {
  v: number;
  q: string;
  ks: Keyset | null;
  so: number;
  m: number;
  buf: Hit[];
}

interface SealedCursor {
  p: CursorPayload;
  c: string;
}

export class SearchIndex {
  private docs: Doc[] = [];
  private version = 0;

  add(doc: Doc): void {
    if (this.docs.some((d) => d.id === doc.id)) {
      throw new Error(`duplicate doc id: ${doc.id}`);
    }
    this.docs.push(doc);
    this.version++;
  }

  remove(id: string): boolean {
    const at = this.docs.findIndex((d) => d.id === id);
    if (at < 0) return false;
    this.docs.splice(at, 1);
    this.version++;
    return true;
  }

  get indexVersion(): number {
    return this.version;
  }

  get size(): number {
    return this.docs.length;
  }

  snapshot(): Doc[] {
    return this.docs.slice();
  }
}

export function scoreDoc(query: Query, doc: Doc): number {
  const term = query.term.toLowerCase();
  if (term.length === 0) return 0;
  const hay = doc.text.toLowerCase();
  let count = 0;
  let at = hay.indexOf(term);
  while (at >= 0) {
    count++;
    at = hay.indexOf(term, at + term.length);
  }
  return count;
}

export function compareHits(a: Hit, b: Hit): number {
  if (a.score !== b.score) return b.score - a.score;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function queryDigest(query: Query): string {
  const canonical = JSON.stringify(query, Object.keys(query).sort());
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

function checksum(payload: CursorPayload): string {
  return createHash("sha256")
    .update(JSON.stringify(payload))
    .digest("hex")
    .slice(0, 12);
}

function encodeCursor(payload: CursorPayload): string {
  const sealed: SealedCursor = { p: payload, c: checksum(payload) };
  return Buffer.from(JSON.stringify(sealed), "utf8").toString("base64url");
}

function decodeCursor(cursor: string): CursorPayload {
  let sealed: SealedCursor;
  try {
    sealed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new MalformedCursorError("cursor is not valid base64url JSON");
  }
  if (
    typeof sealed !== "object" ||
    sealed === null ||
    typeof sealed.p !== "object" ||
    sealed.p === null ||
    typeof sealed.c !== "string" ||
    typeof sealed.p.v !== "number" ||
    typeof sealed.p.q !== "string" ||
    typeof sealed.p.so !== "number" ||
    typeof sealed.p.m !== "number" ||
    !Array.isArray(sealed.p.buf)
  ) {
    throw new MalformedCursorError("cursor payload has unexpected shape");
  }
  if (checksum(sealed.p) !== sealed.c) {
    throw new MalformedCursorError("cursor checksum mismatch");
  }
  return sealed.p;
}

function insertBuffered(buf: Hit[], cand: Hit, limit: number): void {
  if (buf.length === limit && compareHits(cand, buf[buf.length - 1]) >= 0) {
    return;
  }
  let at = buf.length;
  while (at > 0 && compareHits(cand, buf[at - 1]) < 0) at--;
  buf.splice(at, 0, cand);
  if (buf.length > limit) buf.length = limit;
}

export function search(
  index: SearchIndex,
  query: Query,
  options: SearchOptions,
): SearchResult {
  const limit = options.limit;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError("limit must be a positive integer");
  }
  const budget = options.budget ?? Number.POSITIVE_INFINITY;
  if (budget < 0) {
    throw new RangeError("budget must be non-negative");
  }

  const digest = queryDigest(query);
  let keyset: Keyset | null = null;
  let scanOffset = 0;
  let matched = 0;
  let buf: Hit[] = [];

  if (options.cursor !== undefined) {
    const payload = decodeCursor(options.cursor);
    if (payload.v !== index.indexVersion) {
      throw new StaleCursorError(
        `cursor bound to index version ${payload.v}, current is ${index.indexVersion}`,
      );
    }
    if (payload.q !== digest) {
      throw new QueryMismatchError("cursor bound to a different query");
    }
    keyset = payload.ks;
    scanOffset = payload.so;
    matched = payload.m;
    buf = payload.buf.slice();
  }

  const docs = index.snapshot();
  let scanned = 0;
  let at = scanOffset;

  while (at < docs.length && scanned < budget) {
    const doc = docs[at];
    at++;
    scanned++;
    const score = scoreDoc(query, doc);
    if (score <= 0) continue;
    const cand: Hit = { id: doc.id, score };
    if (keyset !== null && compareHits(cand, keyset) <= 0) continue;
    matched++;
    insertBuffered(buf, cand, limit);
  }

  const closed = at === docs.length;

  if (!closed) {
    // Budget exhausted before the scan finished: unknown high-score items may
    // still exist in the unscanned tail, so nothing is emitted and the cursor
    // only records scan progress plus the buffered top-`limit` candidates.
    return {
      items: [],
      nextCursor: encodeCursor({
        v: index.indexVersion,
        q: digest,
        ks: keyset,
        so: at,
        m: matched,
        buf,
      }),
      closed: false,
      scanned,
    };
  }

  const items = buf;
  const hasMore = matched > limit;
  return {
    items,
    nextCursor: hasMore
      ? encodeCursor({
          v: index.indexVersion,
          q: digest,
          ks: {
            score: items[items.length - 1].score,
            id: items[items.length - 1].id,
          },
          so: 0,
          m: 0,
          buf: [],
        })
      : null,
    closed: true,
    scanned,
  };
}

export function fullScan(index: SearchIndex, query: Query): Hit[] {
  const hits: Hit[] = [];
  for (const doc of index.snapshot()) {
    const score = scoreDoc(query, doc);
    if (score > 0) hits.push({ id: doc.id, score });
  }
  return hits.sort(compareHits);
}
