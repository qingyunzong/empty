// RFC 8288 Web Linking - Link header parser.
//
// Handles the tricky parts of the grammar:
//  - quoted-string parameter values (may contain ',' and ';')
//  - backslash escapes inside quoted-string
//  - commas inside <...> URI-references (e.g. </items?ids=1,2,3>)
//  - multiple relation types in one rel param (rel="next prev")
//  - token-form (unquoted) parameter values

export interface LinkEntry {
  /** Raw URI-reference exactly as it appeared between < and >. */
  readonly target: string;
  /** Parameters with lower-cased names; rel is kept as the raw string. */
  readonly params: Readonly<Record<string, string>>;
  /** Relation types from the rel param, lower-cased and split on whitespace. */
  readonly rels: readonly string[];
}

export class LinkHeaderParseError extends Error {
  readonly position: number;

  constructor(message: string, position: number) {
    super(`${message} (at offset ${position})`);
    this.name = 'LinkHeaderParseError';
    this.position = position;
  }
}

const TOKEN_CHAR = /[!#$%&'*+\-.^_`|~0-9A-Za-z]/;

export function parseLinkHeader(header: string): LinkEntry[] {
  const entries: LinkEntry[] = [];
  const len = header.length;
  let pos = 0;

  const skipOws = (): void => {
    while (pos < len && (header[pos] === ' ' || header[pos] === '\t')) pos++;
  };

  while (pos < len) {
    skipOws();
    if (pos >= len) break;
    // Tolerate empty list members (", ,") produced by naive concatenation.
    if (header[pos] === ',') {
      pos++;
      continue;
    }

    if (header[pos] !== '<') {
      throw new LinkHeaderParseError(`expected '<' starting a link-value, got ${JSON.stringify(header[pos])}`, pos);
    }
    pos++;
    const targetStart = pos;
    while (pos < len && header[pos] !== '>') pos++;
    if (pos >= len) throw new LinkHeaderParseError('unterminated URI-reference', targetStart);
    const target = header.slice(targetStart, pos);
    pos++; // consume '>'

    const params: Record<string, string> = {};
    for (;;) {
      skipOws();
      if (pos >= len || header[pos] !== ';') break;
      pos++;
      skipOws();
      const nameStart = pos;
      while (pos < len && TOKEN_CHAR.test(header[pos])) pos++;
      if (pos === nameStart) throw new LinkHeaderParseError('expected parameter name', pos);
      const name = header.slice(nameStart, pos).toLowerCase();
      skipOws();

      let value = '';
      if (header[pos] === '=') {
        pos++;
        skipOws();
        if (header[pos] === '"') {
          pos++;
          let decoded = '';
          for (;;) {
            if (pos >= len) throw new LinkHeaderParseError('unterminated quoted-string', pos);
            const ch = header[pos];
            if (ch === '"') {
              pos++;
              break;
            }
            if (ch === '\\') {
              pos++;
              if (pos >= len) throw new LinkHeaderParseError('unterminated quoted-pair', pos);
              decoded += header[pos];
              pos++;
            } else {
              decoded += ch;
              pos++;
            }
          }
          value = decoded;
        } else {
          const valueStart = pos;
          while (pos < len && TOKEN_CHAR.test(header[pos])) pos++;
          value = header.slice(valueStart, pos);
        }
      }
      params[name] = value;
    }

    const rels = (params['rel'] ?? '')
      .toLowerCase()
      .split(/\s+/)
      .filter((rel) => rel.length > 0);
    entries.push({ target, params, rels });

    skipOws();
    if (pos < len) {
      if (header[pos] !== ',') {
        throw new LinkHeaderParseError(`expected ',' between link-values, got ${JSON.stringify(header[pos])}`, pos);
      }
      pos++;
    }
  }
  return entries;
}

/** First link-value carrying the given relation type, or undefined. */
export function findLink(entries: readonly LinkEntry[], rel: string): LinkEntry | undefined {
  const wanted = rel.toLowerCase();
  return entries.find((entry) => entry.rels.includes(wanted));
}
