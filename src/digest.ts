import { createHash } from "node:crypto";
import { encode, type CanonicalValue } from "./encode.js";

/**
 * Digest of a value's canonical encoding. Because object keys are sorted by
 * UTF-8 byte order during encoding, the digest does not depend on the
 * insertion order of the input object.
 */
export function digest(value: CanonicalValue, algorithm = "sha256"): Buffer {
  return createHash(algorithm).update(encode(value)).digest();
}

export function digestHex(value: CanonicalValue, algorithm = "sha256"): string {
  return digest(value, algorithm).toString("hex");
}
