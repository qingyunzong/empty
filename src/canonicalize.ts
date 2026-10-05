import { canonicalizePath } from './path.js';
import { canonicalizeQuery, type ParamMapping } from './query.js';
import { ByteMap, type Piece } from './bytemap.js';
import { utf8EncodeString } from './percent.js';

export interface CanonicalizedUrl {
  /** The URL exactly as supplied. */
  original: string;
  /** Canonical signing input: canonicalPath + ('?' + canonicalQuery)? */
  canonical: string;
  /** Canonical form as UTF-8 bytes — the bytes that get signed. */
  canonicalBytes: Uint8Array;
  canonicalPath: string;
  canonicalQuery: string | null;
  /** Canonical query parameters with their original-URL intervals. */
  params: ParamMapping[];
  /** Human-readable equivalence derivation steps for this normalization. */
  steps: string[];
  /** Bidirectional offset mapping between `canonical` and `original`. */
  map: ByteMap;
}

const SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;

/**
 * Canonicalize a URL (absolute or relative) for request signing.
 *
 * The fragment is excluded. The path has dot segments removed and the query
 * is sorted; percent escapes decode unreserved ASCII only, and any invalid
 * escape rejects the whole normalization with a CanonicalizationError.
 */
export function canonicalizeUrl(url: string): CanonicalizedUrl {
  const steps: string[] = [];

  const hashIndex = url.indexOf('#');
  const fragless = hashIndex >= 0 ? url.slice(0, hashIndex) : url;
  if (hashIndex >= 0) {
    steps.push(`url: fragment excluded from signature input (offset ${hashIndex})`);
  }

  const qIndex = fragless.indexOf('?');
  const pathPart = qIndex >= 0 ? fragless.slice(0, qIndex) : fragless;
  const rawQuery = qIndex >= 0 ? fragless.slice(qIndex + 1) : null;

  let pathStart = 0;
  const scheme = SCHEME_RE.exec(pathPart);
  if (scheme) {
    const slash = pathPart.indexOf('/', scheme[0].length);
    pathStart = slash >= 0 ? slash : pathPart.length;
    steps.push(`url: scheme/authority skipped, path starts at offset ${pathStart}`);
  }
  const rawPath = pathPart.slice(pathStart);

  const pathResult = canonicalizePath(rawPath, pathStart, steps);

  let canonical = pathResult.path;
  let canonicalQuery: string | null = null;
  let params: ParamMapping[] = [];
  const pieces: Piece[] = [...pathResult.pieces];

  if (rawQuery !== null) {
    const queryResult = canonicalizeQuery(rawQuery, (qIndex as number) + 1, steps);
    canonicalQuery = queryResult.query;
    const shift = pathResult.path.length + 1; // +1 for the '?'
    pieces.push({
      canonStart: pathResult.path.length,
      canonEnd: shift,
      origStart: qIndex as number,
      origEnd: (qIndex as number) + 1,
    });
    for (const piece of queryResult.pieces) {
      pieces.push({
        canonStart: piece.canonStart + shift,
        canonEnd: piece.canonEnd + shift,
        origStart: piece.origStart,
        origEnd: piece.origEnd,
      });
    }
    params = queryResult.params.map((p) => ({
      ...p,
      canonStart: p.canonStart + shift,
      canonEnd: p.canonEnd + shift,
    }));
    canonical += '?' + queryResult.query;
  }

  steps.push(`canonical: derived '${canonical}'`);

  return {
    original: url,
    canonical,
    canonicalBytes: utf8EncodeString(canonical),
    canonicalPath: pathResult.path,
    canonicalQuery,
    params,
    steps,
    map: new ByteMap(pieces, canonical.length, url.length),
  };
}
