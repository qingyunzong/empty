import { Fraction } from "./fraction";
import { Line, XY, lineThrough } from "./bezier";

export interface ParsedInput {
  line: Line;
  segments: XY[][];
}

function parseDecimal(s: string): Fraction {
  const m = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(s.trim());
  if (!m || (m[2] === "" && (m[3] ?? "") === "")) {
    throw new Error(`invalid decimal: ${JSON.stringify(s)}`);
  }
  const intPart = m[2] || "0";
  const fracPart = m[3] || "";
  const exp = m[4] ? parseInt(m[4], 10) : 0;
  let num = BigInt(intPart + fracPart);
  if (m[1] === "-") num = -num;
  const scale = fracPart.length - exp;
  if (scale >= 0) return Fraction.of(num, 10n ** BigInt(scale));
  return Fraction.of(num * 10n ** BigInt(-scale), 1);
}

/** Accepts "p/q", "p", "0.5", 2, 0.5. Strings are exact; numbers use their decimal form. */
export function parseFraction(value: unknown): Fraction {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`invalid number: ${value}`);
    }
    return parseDecimal(String(value));
  }
  if (typeof value === "string") {
    const s = value.trim();
    if (s.includes("/")) {
      const parts = s.split("/");
      if (parts.length !== 2) throw new Error(`invalid rational: ${s}`);
      return Fraction.of(BigInt(parts[0].trim()), BigInt(parts[1].trim()));
    }
    return parseDecimal(s);
  }
  throw new Error(`invalid rational value: ${JSON.stringify(value)}`);
}

function parsePoint(value: unknown, where: string): XY {
  if (
    Array.isArray(value) &&
    value.length === 2
  ) {
    return { x: parseFraction(value[0]), y: parseFraction(value[1]) };
  }
  if (
    typeof value === "object" &&
    value !== null &&
    "x" in value &&
    "y" in value
  ) {
    const rec = value as { x: unknown; y: unknown };
    return { x: parseFraction(rec.x), y: parseFraction(rec.y) };
  }
  throw new Error(`invalid point at ${where}`);
}

/**
 * Expected JSON shape:
 * {
 *   "line": { "p0": ["0", "0"], "p1": ["4", "0"] },
 *   "segments": [
 *     { "points": [["0","1"], ["1","-1"], ["2","1"], ["3","-1"]] },
 *     ...
 *   ]
 * }
 * A segment may also be a bare array of 2..4 points.
 */
export function parseInput(json: unknown): ParsedInput {
  if (typeof json !== "object" || json === null) {
    throw new Error("input must be a JSON object");
  }
  const root = json as Record<string, unknown>;
  const lineRaw = root.line as Record<string, unknown> | undefined;
  if (!lineRaw || lineRaw.p0 === undefined || lineRaw.p1 === undefined) {
    throw new Error('input.line must have "p0" and "p1"');
  }
  const line = lineThrough(
    parsePoint(lineRaw.p0, "line.p0"),
    parsePoint(lineRaw.p1, "line.p1"),
  );
  if (!Array.isArray(root.segments)) {
    throw new Error('input.segments must be an array');
  }
  const segments = root.segments.map((seg: unknown, i: number) => {
    const pts = Array.isArray(seg)
      ? (seg as unknown[])
      : (seg as { points?: unknown[] } | null)?.points;
    if (!Array.isArray(pts)) {
      throw new Error(`segment ${i}: expected { "points": [...] }`);
    }
    return pts.map((p, j) => parsePoint(p, `segment ${i} point ${j}`));
  });
  return { line, segments };
}
