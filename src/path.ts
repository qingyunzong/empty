/**
 * Parser for a limited SVG-style path command set: move (M/m), line (L/l),
 * close (Z/z). Horizontal/vertical shortcuts, curves and arcs are rejected.
 */

export interface Point {
  x: number;
  y: number;
}

export interface Subpath {
  /** Vertices in order. The closing vertex is NOT duplicated for Z. */
  points: Point[];
  /** True when the subpath was explicitly terminated with Z/z. */
  closed: boolean;
}

export class PathParseError extends Error {
  constructor(message: string, public readonly offset: number) {
    super(message);
    this.name = 'PathParseError';
  }
}

type Token =
  | { kind: 'command'; value: string; offset: number }
  | { kind: 'number'; value: number; offset: number };

const NUMBER_RE = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/;
const COMMAND_RE = /^[MmLlZz]/;

function tokenize(d: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < d.length) {
    const ch = d[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',' || ch === '\f') {
      i += 1;
      continue;
    }
    const rest = d.slice(i);
    const cmd = COMMAND_RE.exec(rest);
    if (cmd) {
      tokens.push({ kind: 'command', value: cmd[0], offset: i });
      i += cmd[0].length;
      continue;
    }
    const num = NUMBER_RE.exec(rest);
    if (num) {
      tokens.push({ kind: 'number', value: Number(num[0]), offset: i });
      i += num[0].length;
      continue;
    }
    throw new PathParseError(`Unexpected character ${JSON.stringify(ch)}`, i);
  }
  return tokens;
}

/**
 * Parse path data into subpaths. Open subpaths are returned with
 * `closed: false`; callers performing fill semantics must close them
 * implicitly (see geometry.ringEdges).
 */
export function parsePath(d: string): Subpath[] {
  const tokens = tokenize(d);
  const subpaths: Subpath[] = [];

  let pos = 0;
  let current: Point = { x: 0, y: 0 };
  let subpathStart: Point = { x: 0, y: 0 };
  let open: Subpath | null = null;

  const peek = (): Token | undefined => tokens[pos];

  const readNumber = (what: string): number => {
    const tok = tokens[pos];
    if (!tok || tok.kind !== 'number') {
      throw new PathParseError(
        `Expected ${what} coordinate`,
        tok ? tok.offset : d.length,
      );
    }
    pos += 1;
    return tok.value;
  };

  const readPair = (relative: boolean, what: string): Point => {
    const x = readNumber(what);
    const y = readNumber(what);
    return relative ? { x: current.x + x, y: current.y + y } : { x, y };
  };

  const beginSubpath = (p: Point): Subpath => {
    const subpath: Subpath = { points: [p], closed: false };
    subpaths.push(subpath);
    subpathStart = { ...p };
    current = { ...p };
    return subpath;
  };

  while (pos < tokens.length) {
    const tok = peek()!;
    if (tok.kind !== 'command') {
      throw new PathParseError('Path data must begin with a command', tok.offset);
    }
    pos += 1;
    const cmd = tok.value;
    const relative = cmd === cmd.toLowerCase();

    switch (cmd.toUpperCase()) {
      case 'M': {
        const first = readPair(relative, 'move');
        const subpath = beginSubpath(first);
        open = subpath;
        // Per SVG, extra coordinate pairs after M are implicit line-to's.
        while (peek()?.kind === 'number') {
          const p = readPair(relative, 'line');
          subpath.points.push(p);
          current = { ...p };
        }
        break;
      }
      case 'L': {
        if (!open) {
          throw new PathParseError('Line command without an open subpath', tok.offset);
        }
        let consumed = false;
        while (peek()?.kind === 'number') {
          const p = readPair(relative, 'line');
          open.points.push(p);
          current = { ...p };
          consumed = true;
        }
        if (!consumed) {
          throw new PathParseError('Line command requires coordinates', tok.offset);
        }
        break;
      }
      case 'Z': {
        if (!open) {
          throw new PathParseError('Close command without an open subpath', tok.offset);
        }
        open.closed = true;
        current = { ...subpathStart };
        open = null;
        break;
      }
      default:
        throw new PathParseError(`Unsupported command ${cmd}`, tok.offset);
    }
  }

  return subpaths;
}
