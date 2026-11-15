import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { EndpointConfig, KeySecret } from "./types.js";
import {
  InvalidSignatureError,
  MalformedEnvelopeError,
  TimestampSkewError,
  UnknownKeyError,
} from "./errors.js";

/** Signature scheme version. Bump when the canonical string changes. */
export const SIGNATURE_VERSION = "v1";
export const SIGNATURE_ALGORITHM = "sha256";

/** SHA-256 hex digest of the raw body. Used for idempotency and conflict checks. */
export function bodyDigest(body: Buffer): string {
  return createHash("sha256").update(body).digest("hex");
}

/**
 * Bytes that are signed. The delivery id and timestamp are bound into the
 * canonical string so neither can be swapped after signing, and the raw body
 * is appended byte-for-byte (no re-encoding) to match what was transmitted.
 */
export function canonicalString(
  deliveryId: string,
  timestamp: number,
  body: Buffer,
): Buffer {
  const prefix = Buffer.from(`${deliveryId}.${timestamp}.`, "utf8");
  return Buffer.concat([prefix, body]);
}

function hmacFor(key: string | Buffer, payload: Buffer): Buffer {
  return createHmac(SIGNATURE_ALGORITHM, key).update(payload).digest();
}

/** Produce a single `version,kid,mac` signature token. */
export function signDelivery(
  key: KeySecret,
  deliveryId: string,
  timestamp: number,
  body: Buffer,
): string {
  const mac = hmacFor(key.secret, canonicalString(deliveryId, timestamp, body));
  return `${SIGNATURE_VERSION},${key.id},${mac.toString("base64url")}`;
}

/** Build a signature header containing one token per key generation (rotation). */
export function buildSignatureHeader(
  keys: readonly KeySecret[],
  deliveryId: string,
  timestamp: number,
  body: Buffer,
): string {
  return keys
    .map((key) => signDelivery(key, deliveryId, timestamp, body))
    .join(" ");
}

interface SignatureToken {
  readonly version: string;
  readonly keyId: string;
  readonly mac: Buffer;
}

/** Parse a header of space-separated `version,kid,mac` tokens. */
export function parseSignatureHeader(header: string): SignatureToken[] {
  const tokens: SignatureToken[] = [];
  for (const raw of header.trim().split(/\s+/)) {
    if (raw === "") continue;
    const parts = raw.split(",");
    if (parts.length !== 3 || parts.some((part) => part === "")) {
      throw new MalformedEnvelopeError(
        `Malformed signature token "${raw}"; expected "${SIGNATURE_VERSION},<kid>,<mac>"`,
      );
    }
    const version = parts[0]!;
    const keyId = parts[1]!;
    const encodedMac = parts[2]!;
    let mac: Buffer;
    try {
      mac = Buffer.from(encodedMac, "base64url");
    } catch {
      throw new MalformedEnvelopeError(`Signature mac for key "${keyId}" is not valid base64url`);
    }
    if (mac.length === 0) {
      throw new MalformedEnvelopeError(`Signature mac for key "${keyId}" is empty`);
    }
    tokens.push({ version, keyId, mac });
  }
  if (tokens.length === 0) {
    throw new MalformedEnvelopeError("Signature header contained no tokens");
  }
  return tokens;
}

/** Parse the unix-millisecond timestamp header, rejecting non-integers. */
export function parseTimestampHeader(rawTimestamp: string): number {
  if (!/^\d+$/.test(rawTimestamp)) {
    throw new MalformedEnvelopeError(`Timestamp header "${rawTimestamp}" is not a unix millisecond integer`);
  }
  const timestamp = Number(rawTimestamp);
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0) {
    throw new MalformedEnvelopeError(`Timestamp header "${rawTimestamp}" is out of range`);
  }
  return timestamp;
}

export interface VerifiedSignature {
  readonly keyId: string;
  readonly timestamp: number;
}

/**
 * Verify a webhook envelope against every key generation of the endpoint.
 *
 * The timestamp is checked first to enforce the replay window, then each
 * signature token is matched to a configured key generation and compared in
 * constant time. Multiple tokens (one per overlapping generation during a key
 * rotation) are accepted as long as exactly one validates; duplicate tokens
 * for the same kid still only validate the same delivery once because
 * idempotency is enforced downstream by delivery id.
 */
export function verifySignature(
  endpoint: EndpointConfig,
  deliveryId: string,
  rawTimestamp: string,
  body: Buffer,
  signatureHeader: string,
  nowMs: number = Date.now(),
): VerifiedSignature {
  const timestamp = parseTimestampHeader(rawTimestamp);
  if (Math.abs(nowMs - timestamp) > endpoint.timestampToleranceMs) {
    throw new TimestampSkewError(timestamp, endpoint.timestampToleranceMs, endpoint.id, deliveryId);
  }

  const tokens = parseSignatureHeader(signatureHeader);
  const payload = canonicalString(deliveryId, timestamp, body);
  const keysById = new Map(endpoint.keys.map((key) => [key.id, key]));

  let matchedKey: KeySecret | undefined;
  let sawUnknownKey = false;

  for (const token of tokens) {
    if (token.version !== SIGNATURE_VERSION) continue;
    const key = keysById.get(token.keyId);
    if (!key) {
      sawUnknownKey = true;
      continue;
    }
    const expected = hmacFor(key.secret, payload);
    if (expected.length === token.mac.length && timingSafeEqual(expected, token.mac)) {
      matchedKey = key;
      break;
    }
  }

  if (matchedKey) {
    return { keyId: matchedKey.id, timestamp };
  }
  const firstToken = tokens[0]!;
  if (sawUnknownKey && !keysById.has(firstToken.keyId)) {
    throw new UnknownKeyError(firstToken.keyId, endpoint.id, deliveryId);
  }
  throw new InvalidSignatureError(endpoint.id, deliveryId);
}
