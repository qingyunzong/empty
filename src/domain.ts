/**
 * ASCII domain normalization and validation.
 *
 * Normalization: ASCII case folding (to lowercase) and trailing-dot
 * (root label) normalization — exactly one trailing dot is stripped.
 *
 * Rejections:
 *  - non-ASCII input (illegal encoding; we never see bytes, so any
 *    code point > 0x7f is rejected before any decoding happens)
 *  - empty labels (`a..b`, leading dot, `..`, residual trailing dot)
 *  - labels with characters outside [a-z0-9-], or hyphens at either end
 *  - labels longer than 63 octets / names longer than 253 octets
 *  - IP-masquerading names: anything that parses as an IPv4 address in
 *    any inet_aton form (dotted-quad, short forms, octal/hex parts, or a
 *    single 32-bit number). IPv6 cannot masquerade here because `:` and
 *    `[`/`]` are not valid label characters and are rejected anyway.
 */

export type DomainError =
  | "EMPTY_INPUT"
  | "NON_ASCII"
  | "EMPTY_LABEL"
  | "LABEL_TOO_LONG"
  | "NAME_TOO_LONG"
  | "INVALID_CHAR"
  | "BAD_HYPHEN"
  | "IP_MASQUERADE";

export type NormalizeResult =
  | { ok: true; domain: string }
  | { ok: false; error: DomainError; detail: string };

const MAX_LABEL_LENGTH = 63;
const MAX_NAME_LENGTH = 253;

/** Parse one inet_aton-style numeric part: decimal, octal (0…), hex (0x…). */
function parseNumericPart(part: string): number | null {
  let m = /^0[xX]([0-9a-fA-F]+)$/.exec(part);
  if (m) return Number.parseInt(m[1]!, 16);
  if (/^0[0-7]+$/.test(part)) return Number.parseInt(part, 8);
  if (/^[0-9]+$/.test(part)) return Number.parseInt(part, 10);
  return null;
}

/**
 * True iff `name` (already normalized, dot-separated) is a valid IPv4
 * address under inet_aton semantics: 1–4 numeric parts, all but the last
 * in 0..255, the last fitting the remaining address bits.
 */
export function isIPv4Address(name: string): boolean {
  const labels = name.split(".");
  if (labels.length < 1 || labels.length > 4) return false;
  const values: number[] = [];
  for (const label of labels) {
    const v = parseNumericPart(label);
    if (v === null) return false;
    values.push(v);
  }
  for (let i = 0; i < values.length - 1; i++) {
    if (values[i]! > 0xff) return false;
  }
  const lastBits = (5 - values.length) * 8; // 4 parts -> 8 bits, 1 part -> 32 bits
  const maxLast = lastBits >= 31 ? 0xffffffff : (1 << lastBits) - 1;
  return values[values.length - 1]! <= maxLast;
}

const LABEL_RE = /^[a-z0-9-]+$/;

export function normalizeDomain(raw: string): NormalizeResult {
  if (raw.length === 0) {
    return { ok: false, error: "EMPTY_INPUT", detail: "input is empty" };
  }
  for (let i = 0; i < raw.length; i++) {
    if (raw.charCodeAt(i) > 0x7f) {
      return {
        ok: false,
        error: "NON_ASCII",
        detail: `non-ASCII character U+${raw.charCodeAt(i).toString(16).toUpperCase()} at index ${i}`,
      };
    }
  }
  // Case folding (ASCII only; non-ASCII was rejected above).
  let name = raw.toLowerCase();
  // Trailing-dot normalization: strip exactly one root dot.
  if (name.endsWith(".")) name = name.slice(0, -1);
  if (name.length === 0) {
    return { ok: false, error: "EMPTY_LABEL", detail: "name is just a dot" };
  }
  if (name.length > MAX_NAME_LENGTH) {
    return { ok: false, error: "NAME_TOO_LONG", detail: `length ${name.length} > ${MAX_NAME_LENGTH}` };
  }
  const labels = name.split(".");
  for (const label of labels) {
    if (label.length === 0) {
      return { ok: false, error: "EMPTY_LABEL", detail: `empty label in "${name}"` };
    }
    if (label.length > MAX_LABEL_LENGTH) {
      return { ok: false, error: "LABEL_TOO_LONG", detail: `label "${label.slice(0, 20)}…" exceeds ${MAX_LABEL_LENGTH} octets` };
    }
    if (!LABEL_RE.test(label)) {
      return { ok: false, error: "INVALID_CHAR", detail: `label "${label}" contains characters outside [a-z0-9-]` };
    }
    if (label.startsWith("-") || label.endsWith("-")) {
      return { ok: false, error: "BAD_HYPHEN", detail: `label "${label}" starts or ends with a hyphen` };
    }
  }
  if (isIPv4Address(name)) {
    return { ok: false, error: "IP_MASQUERADE", detail: `"${name}" parses as an IPv4 address` };
  }
  return { ok: true, domain: name };
}
