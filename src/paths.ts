/**
 * Public path rules, e.g. "meta.updatedAt", "items[0].id", "users[*].token",
 * "lines.*.ts". A segment "*" (or "[*]") matches any single key or index.
 * Numeric segments ("0" or "[0]") match array index 0.
 */

export type PathSeg = string | number;
export type RuleSeg = PathSeg | "*";

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

export function parseRule(rule: string): RuleSeg[] {
  if (rule === "" || rule === "$") return [];
  const src = rule.startsWith("$.") ? rule.slice(2) : rule;
  const segs: RuleSeg[] = [];
  let i = 0;
  let buf = "";
  const flush = (): void => {
    if (buf === "") throw new Error(`invalid path rule: ${JSON.stringify(rule)}`);
    segs.push(toSeg(buf));
    buf = "";
  };
  while (i < src.length) {
    const ch = src[i]!;
    if (ch === ".") {
      if (buf === "" && i > 0 && src[i - 1] === "]") {
        i += 1; // separator right after a bracket segment: "a[0].b"
      } else {
        flush();
        i += 1;
      }
    } else if (ch === "[") {
      if (buf !== "") flush();
      const end = src.indexOf("]", i);
      if (end < 0) throw new Error(`invalid path rule: ${JSON.stringify(rule)}`);
      const inner = src.slice(i + 1, end).trim();
      if (inner === "") throw new Error(`invalid path rule: ${JSON.stringify(rule)}`);
      segs.push(toSeg(inner));
      i = end + 1;
    } else {
      buf += ch;
      i += 1;
    }
  }
  if (buf !== "") flush();
  else if (src.endsWith(".")) {
    throw new Error(`invalid path rule: ${JSON.stringify(rule)}`);
  }
  return segs;
}

function toSeg(raw: string): RuleSeg {
  if (raw === "*") return "*";
  if (/^-?\d+$/.test(raw)) return Number(raw);
  return raw;
}

/** Format a concrete path in canonical public form: $.a.b[0].c */
export function formatPath(path: readonly PathSeg[]): string {
  let out = "$";
  for (const seg of path) {
    if (typeof seg === "number") out += `[${seg}]`;
    else if (IDENT.test(seg)) out += `.${seg}`;
    else out += `[${JSON.stringify(seg)}]`;
  }
  return out;
}

export function matchRule(rule: readonly RuleSeg[], path: readonly PathSeg[]): boolean {
  if (rule.length !== path.length) return false;
  for (let i = 0; i < rule.length; i += 1) {
    const r = rule[i]!;
    if (r === "*") continue;
    if (r !== path[i]) return false;
  }
  return true;
}

export function matchAnyRule(
  rules: readonly (readonly RuleSeg[])[],
  path: readonly PathSeg[],
): number {
  for (let i = 0; i < rules.length; i += 1) {
    if (matchRule(rules[i]!, path)) return i;
  }
  return -1;
}
