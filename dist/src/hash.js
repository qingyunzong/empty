import { createHash } from "node:crypto";
/** Domain-separated SHA-256 over a list of parts (NUL-delimited). */
export function sha256(...parts) {
    const h = createHash("sha256");
    for (const part of parts) {
        h.update(part);
        h.update("\0");
    }
    return h.digest("hex");
}
