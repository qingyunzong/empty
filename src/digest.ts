import { createHash } from "node:crypto";
import { canonicalize } from "./canonical.js";

export const DIGEST_PREFIX = "sha256:";

export function sha256Hex(data: string): string {
  return createHash("sha256").update(data, "utf8").digest("hex");
}

/** Digest of raw resource content. */
export function digestContent(content: string): string {
  return DIGEST_PREFIX + sha256Hex(content);
}

/** Digest of an arbitrary structured value via canonical JSON. */
export function digestValue(value: unknown): string {
  return DIGEST_PREFIX + sha256Hex(canonicalize(value));
}

export function isDigestFormat(digest: unknown): digest is string {
  return (
    typeof digest === "string" &&
    digest.startsWith(DIGEST_PREFIX) &&
    /^[0-9a-f]{64}$/.test(digest.slice(DIGEST_PREFIX.length))
  );
}
