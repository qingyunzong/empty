import type { ScalarNode, ScalarStyle, ScalarValue, YamlNode } from "./types.ts";

export const TAG_PREFIX = "tag:yaml.org,2002:";
export const TAGS = {
  str: `${TAG_PREFIX}str`,
  int: `${TAG_PREFIX}int`,
  float: `${TAG_PREFIX}float`,
  bool: `${TAG_PREFIX}bool`,
  null: `${TAG_PREFIX}null`,
  merge: `${TAG_PREFIX}merge`,
  binary: `${TAG_PREFIX}binary`,
  timestamp: `${TAG_PREFIX}timestamp`,
  seq: `${TAG_PREFIX}seq`,
  map: `${TAG_PREFIX}map`,
  set: `${TAG_PREFIX}set`,
} as const;

const NULL_RE = /^(?:~|null|Null|NULL)$/;
const TRUE_RE = /^(?:true|True|TRUE)$/;
const FALSE_RE = /^(?:false|False|FALSE)$/;
const INT_RE =
  /^[-+]?(?:0b[0-1_]+|0o[0-7_]+|0x[0-9a-fA-F_]+|[0-9][0-9_]*)$/;
const FLOAT_RE =
  /^[-+]?(?:(?:[0-9][0-9_]*)?\.[0-9_]*|[0-9][0-9_]*\.)(?:[eE][-+]?[0-9]+)?$/;
const EXP_FLOAT_RE = /^[-+]?[0-9][0-9_]*(?:[eE][-+]?[0-9]+)$/;
const SPECIAL_FLOAT_RE = /^[-+]?(?:\.inf|\.Inf|\.INF|\.nan|\.NaN|\.NAN)$/;

export function normalizeTag(tag: string | undefined): string | undefined {
  if (!tag) return undefined;
  if (tag === "!" || tag === "!!str") return TAGS.str;
  if (tag.startsWith("!!")) return `${TAG_PREFIX}${tag.slice(2)}`;
  if (tag.startsWith("!<") && tag.endsWith(">")) return tag.slice(2, -1);
  return tag;
}

export function resolvePlainTag(raw: string): string {
  if (raw.length === 0) return TAGS.null;
  if (NULL_RE.test(raw)) return TAGS.null;
  if (TRUE_RE.test(raw) || FALSE_RE.test(raw)) return TAGS.bool;
  if (INT_RE.test(raw)) return TAGS.int;
  if (FLOAT_RE.test(raw) || EXP_FLOAT_RE.test(raw) || SPECIAL_FLOAT_RE.test(raw)) {
    return TAGS.float;
  }
  if (raw === "<<") return TAGS.merge;
  return TAGS.str;
}

export function resolveScalarTag(
  explicitTag: string | undefined,
  style: ScalarStyle,
  raw: string,
): string {
  const normalized = normalizeTag(explicitTag);
  if (normalized) return normalized;
  if (style !== "plain") return TAGS.str;
  return resolvePlainTag(raw);
}

export function resolveScalarValue(
  tag: string,
  raw: string,
  style: ScalarStyle,
): ScalarValue {
  if (tag === TAGS.null) return null;
  if (tag === TAGS.bool) {
    return raw === "true" || raw === "True" || raw === "TRUE";
  }
  if (tag === TAGS.int) return parseIntValue(raw);
  if (tag === TAGS.float) return parseFloatValue(raw);
  if (tag === TAGS.binary) {
    try {
      const BufferCtor = (globalThis as { Buffer?: { from(input: string, encoding: string): { toString(encoding: string): string } } }).Buffer;
      if (!BufferCtor) return raw;
      return BufferCtor.from(raw.replace(/\s+/g, ""), "base64").toString("utf8");
    } catch {
      return raw;
    }
  }
  // Strings, timestamps and application tags all keep their scalar text.
  return raw;
}

function parseIntValue(raw: string): number {
  const text = raw.replace(/_/g, "");
  const sign = text.startsWith("-") ? -1 : 1;
  const unsigned = text.replace(/^[-+]/, "");
  if (unsigned.startsWith("0b")) {
    return sign * Number.parseInt(unsigned.slice(2), 2);
  }
  if (unsigned.startsWith("0o")) {
    return sign * Number.parseInt(unsigned.slice(2), 8);
  }
  if (unsigned.startsWith("0x")) {
    return sign * Number.parseInt(unsigned.slice(2), 16);
  }
  return Number.parseInt(text, 10);
}

function parseFloatValue(raw: string): number {
  const text = raw.replace(/_/g, "").toLowerCase();
  if (text.endsWith(".inf")) return text.startsWith("-") ? -Infinity : Infinity;
  if (text.endsWith(".nan")) return NaN;
  return Number.parseFloat(text);
}

export function canonicalScalar(tag: string, value: ScalarValue): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (Number.isNaN(value)) return "NaN";
    if (value === Infinity) return "Infinity";
    if (value === -Infinity) return "-Infinity";
    if (Object.is(value, -0)) return "-0";
    return String(value);
  }
  return JSON.stringify(String(value));
}

export function scalarNode(
  raw: string,
  style: ScalarStyle,
  explicitTag: string | undefined,
): ScalarNode {
  // The parser fills id/path/range after construction. Keeping tag resolution
  // here ensures quoted text can never accidentally become a number.
  const tag = resolveScalarTag(explicitTag, style, raw);
  const value = resolveScalarValue(tag, raw, style);
  return {
    id: "",
    kind: "scalar",
    type: "scalar",
    tag,
    explicitTag,
    value,
    raw,
    style,
    canonical: canonicalScalar(tag, value),
    path: "$",
    range: {
      start: { offset: 0, line: 1, column: 1 },
      end: { offset: 0, line: 1, column: 1 },
    },
  };
}

export function displayKey(node: YamlNode): string {
  if (node.kind === "scalar") return node.raw;
  if (node.kind === "sequence") return "[...]";
  return "{...}";
}

export function keyIdentity(node: YamlNode, visiting = new Set<YamlNode>()): string {
  if (node.kind === "scalar") {
    return `s:${node.tag}:${node.canonical}`;
  }
  if (visiting.has(node)) return `cycle:${node.id}`;
  visiting.add(node);
  let result: string;
  if (node.kind === "sequence") {
    result = `q:[${node.items.map((item) => keyIdentity(item, visiting)).join(",")}]`;
  } else {
    result = `m:{${node.entries
      .map(
        (entry) =>
          `${keyIdentity(entry.key, visiting)}=${keyIdentity(entry.value, visiting)}`,
      )
      .join(",")}}`;
  }
  visiting.delete(node);
  return result;
}
