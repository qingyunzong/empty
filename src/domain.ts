import { isIPv4 } from "node:net";

export const MAX_DOMAIN_LENGTH = 253;
export const MAX_LABEL_LENGTH = 63;

export type NormalizeResult =
  | { ok: true; domain: string; labels: string[] }
  | { ok: false; error: string };

const LABEL_RE = /^[a-z0-9-]+$/;
const ALL_DIGITS_RE = /^[0-9]+$/;

function fail(error: string): NormalizeResult {
  return { ok: false, error };
}

/**
 * Normalize and validate an ASCII domain name:
 *  - reject non-ASCII input (illegal encoding for this rule library)
 *  - case-fold to lowercase
 *  - strip a single trailing root dot ("example.com." -> "example.com")
 *  - reject empty labels, overlong labels/domains, illegal label characters,
 *    leading/trailing hyphens
 *  - reject IPv4-address impersonation ("1.2.3.4", "999.1.2.3")
 */
export function normalizeDomain(input: string): NormalizeResult {
  if (typeof input !== "string" || input.length === 0) {
    return fail("empty domain");
  }
  for (const ch of input) {
    const code = ch.charCodeAt(0);
    if (code > 0x7f) {
      return fail(
        `non-ASCII character U+${code.toString(16).padStart(4, "0")}: illegal encoding`,
      );
    }
  }

  let name = input.toLowerCase();
  if (name.endsWith(".")) {
    name = name.slice(0, -1);
  }
  if (name.length === 0) {
    return fail("root domain is not allowed");
  }
  if (name.length > MAX_DOMAIN_LENGTH) {
    return fail(`domain too long (${name.length} > ${MAX_DOMAIN_LENGTH})`);
  }

  const labels = name.split(".");
  for (const label of labels) {
    if (label.length === 0) {
      return fail("empty label");
    }
    if (label.length > MAX_LABEL_LENGTH) {
      return fail(`label too long (${label.length} > ${MAX_LABEL_LENGTH})`);
    }
    if (!LABEL_RE.test(label)) {
      return fail(`illegal character in label "${label}"`);
    }
    if (label.startsWith("-") || label.endsWith("-")) {
      return fail(`label "${label}" starts or ends with a hyphen`);
    }
  }

  const numericQuad =
    labels.length === 4 && labels.every((l) => ALL_DIGITS_RE.test(l));
  if (numericQuad || isIPv4(name)) {
    return fail("IPv4 address masquerading as a domain");
  }

  return { ok: true, domain: name, labels };
}
