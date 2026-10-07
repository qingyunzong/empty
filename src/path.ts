import type { Point } from "./geometry.ts";

export interface Subpath {
  readonly points: Point[];
  /** True when the subpath was explicitly closed with Z/z. */
  readonly closed: boolean;
}

interface Token {
  kind: "cmd" | "num";
  value: string;
}

function tokenize(d: string): Token[] {
  const tokens: Token[] = [];
  const re = /[MmLlZz]|-?\d+/g;
  let last = 0;
  for (const m of d.matchAll(re)) {
    const gap = d.slice(last, m.index);
    if (!/^[\s,]*$/.test(gap)) {
      throw new Error(`invalid path syntax near ${JSON.stringify(gap)}`);
    }
    const value = m[0];
    tokens.push({ kind: /^[A-Za-z]$/.test(value) ? "cmd" : "num", value });
    last = m.index! + value.length;
  }
  if (!/^[\s,]*$/.test(d.slice(last))) {
    throw new Error(`invalid path syntax near ${JSON.stringify(d.slice(last))}`);
  }
  return tokens;
}

/**
 * Parse a finite move/line/close command string (M/m, L/l, Z/z) with integer
 * coordinates into subpaths. Extra coordinate pairs after M act as implicit
 * lineto, matching SVG path semantics.
 */
export function parsePath(d: string): Subpath[] {
  const tokens = tokenize(d);
  const subpaths: Subpath[] = [];
  let points: Point[] = [];
  let cur: Point = { x: 0, y: 0 };
  let subStart: Point = cur;
  let i = 0;

  const flush = (closed: boolean): void => {
    if (points.length > 0) subpaths.push({ points, closed });
    points = [];
  };
  const readNum = (): number => {
    const t = tokens[i++];
    if (!t || t.kind !== "num") throw new Error("expected integer coordinate");
    return Number(t.value);
  };
  const nextIsNum = (): boolean => tokens[i]?.kind === "num";

  while (i < tokens.length) {
    const t = tokens[i++];
    if (t.kind !== "cmd") throw new Error(`unexpected coordinate ${t.value}`);
    switch (t.value) {
      case "M":
      case "m": {
        const rel = t.value === "m";
        const x = readNum() + (rel ? cur.x : 0);
        const y = readNum() + (rel ? cur.y : 0);
        flush(false);
        cur = { x, y };
        subStart = cur;
        points.push(cur);
        while (nextIsNum()) {
          const lx = readNum() + (rel ? cur.x : 0);
          const ly = readNum() + (rel ? cur.y : 0);
          cur = { x: lx, y: ly };
          points.push(cur);
        }
        break;
      }
      case "L":
      case "l": {
        if (points.length === 0) throw new Error("lineto without an active subpath");
        const rel = t.value === "l";
        if (!nextIsNum()) throw new Error("lineto requires coordinates");
        while (nextIsNum()) {
          const lx = readNum() + (rel ? cur.x : 0);
          const ly = readNum() + (rel ? cur.y : 0);
          cur = { x: lx, y: ly };
          points.push(cur);
        }
        break;
      }
      case "Z":
      case "z": {
        if (points.length === 0) throw new Error("close without an active subpath");
        flush(true);
        cur = subStart;
        break;
      }
      default:
        throw new Error(`unsupported command ${t.value}`);
    }
  }
  flush(false);
  return subpaths;
}
