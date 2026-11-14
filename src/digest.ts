import { getHeader } from "./headers.ts";
import type {
  DigestInput,
  DigestSpec,
  DownloadEvent,
  NetworkResponse,
} from "./types.ts";

const ALGORITHM_ALIASES: Record<string, string> = {
  sha: "sha-1",
  sha1: "sha-1",
  "sha-1": "sha-1",
  sha256: "sha-256",
  "sha-256": "sha-256",
  sha384: "sha-384",
  "sha-384": "sha-384",
  sha512: "sha-512",
  "sha-512": "sha-512",
  md5: "md5",
};

const WEB_CRYPTO_NAMES: Record<string, string> = {
  "sha-1": "SHA-1",
  "sha-256": "SHA-256",
  "sha-384": "SHA-384",
  "sha-512": "SHA-512",
};

const DIGEST_BYTES: Record<string, number> = {
  md5: 16,
  "sha-1": 20,
  "sha-256": 32,
  "sha-384": 48,
  "sha-512": 64,
};

export function canonicalDigestAlgorithm(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/\s+/g, "");
  return ALGORITHM_ALIASES[normalized] ?? normalized;
}

export function isSupportedDigestAlgorithm(value: string): boolean {
  return Boolean(WEB_CRYPTO_NAMES[canonicalDigestAlgorithm(value)]);
}

function bytesToHex(bytes: Uint8Array): string {
  let result = "";
  for (const byte of bytes) {
    result += byte.toString(16).padStart(2, "0");
  }
  return result;
}

function base64ToHex(value: string): string | undefined {
  const compact = value.replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
  const padded = compact.padEnd(Math.ceil(compact.length / 4) * 4, "=");
  try {
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytesToHex(bytes);
  } catch {
    return undefined;
  }
}

/**
 * Converts hex or base64 digest values (including structured-field delimiters
 * such as `:...:`) to lower-case hex for comparison.
 */
export function digestToHex(value: string): string | undefined {
  let candidate = value.trim();
  if (candidate.startsWith("\"") && candidate.endsWith("\"")) {
    candidate = candidate.slice(1, -1);
  }
  if (candidate.startsWith(":") && candidate.endsWith(":")) {
    candidate = candidate.slice(1, -1);
  }
  if (/^[a-fA-F0-9]+$/.test(candidate) && candidate.length % 2 === 0) {
    return candidate.toLowerCase();
  }
  return base64ToHex(candidate);
}

function inferAlgorithmFromHex(value: string): string | undefined {
  const bytes = value.length / 2;
  for (const [algorithm, length] of Object.entries(DIGEST_BYTES)) {
    if (length === bytes) {
      return algorithm;
    }
  }
  return undefined;
}

export function parseDigestSpec(value: DigestInput): DigestSpec | undefined {
  if (typeof value !== "string") {
    const algorithm = canonicalDigestAlgorithm(value.algorithm);
    return algorithm && value.value ? { algorithm, value: value.value } : undefined;
  }

  const equals = value.indexOf("=");
  if (equals > 0 && equals < value.length - 1) {
    return {
      algorithm: canonicalDigestAlgorithm(value.slice(0, equals)),
      value: value.slice(equals + 1).trim(),
    };
  }

  const sri = /^(sha1|sha256|sha384|sha512|md5)-(.+)$/i.exec(value.trim());
  if (sri) {
    return {
      algorithm: canonicalDigestAlgorithm(sri[1]!),
      value: sri[2]!,
    };
  }

  const colon = value.indexOf(":");
  if (colon > 0 && colon < value.length - 1) {
    const algorithm = canonicalDigestAlgorithm(value.slice(0, colon));
    if (ALGORITHM_ALIASES[algorithm]) {
      return { algorithm, value: value.slice(colon + 1).trim() };
    }
  }

  const hex = digestToHex(value);
  if (!hex) {
    return undefined;
  }
  const algorithm = inferAlgorithmFromHex(hex);
  return algorithm ? { algorithm, value: hex } : undefined;
}

function splitDigestList(value: string): string[] {
  const result: string[] = [];
  let quoted = false;
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === "\"") {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      result.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  result.push(value.slice(start).trim());
  return result.filter(Boolean);
}

function parseStructuredDigestHeader(value: string): DigestSpec[] {
  return splitDigestList(value)
    .map((part) => {
      const equals = part.indexOf("=");
      if (equals < 0) {
        return undefined;
      }
      return {
        algorithm: canonicalDigestAlgorithm(part.slice(0, equals)),
        value: part.slice(equals + 1).trim(),
      };
    })
    .filter((item): item is DigestSpec => Boolean(item));
}

function parseGoogHash(value: string): DigestSpec[] {
  return splitDigestList(value)
    .map((part) => {
      const equals = part.indexOf("=");
      if (equals < 0) {
        return undefined;
      }
      return {
        algorithm: canonicalDigestAlgorithm(part.slice(0, equals)),
        value: part.slice(equals + 1).trim(),
      };
    })
    .filter((item): item is DigestSpec => Boolean(item));
}

function pushUnique(target: DigestSpec[], value: DigestSpec | undefined): void {
  if (!value) {
    return;
  }
  if (
    !target.some(
      (existing) =>
        existing.algorithm === value.algorithm && existing.value === value.value,
    )
  ) {
    target.push(value);
  }
}

export function parseDigestHeaders(
  headers: Parameters<typeof getHeader>[0],
): DigestSpec[] {
  const result: DigestSpec[] = [];

  const contentDigest = getHeader(headers, "content-digest");
  if (contentDigest) {
    for (const value of parseStructuredDigestHeader(contentDigest)) {
      pushUnique(result, value);
    }
  }

  const digest = getHeader(headers, "digest");
  if (digest) {
    for (const value of parseStructuredDigestHeader(digest)) {
      pushUnique(result, value);
    }
  }

  for (const name of [
    "x-checksum-sha256",
    "x-amz-checksum-sha256",
    "x-content-sha256",
  ]) {
    const value = getHeader(headers, name);
    if (value) {
      pushUnique(result, { algorithm: "sha-256", value: value.trim() });
    }
  }

  const googHash = getHeader(headers, "x-goog-hash");
  if (googHash) {
    for (const value of parseGoogHash(googHash)) {
      pushUnique(result, value);
    }
  }

  const contentMd5 = getHeader(headers, "content-md5");
  if (contentMd5) {
    pushUnique(result, { algorithm: "md5", value: contentMd5.trim() });
  }

  return result;
}

function toBytes(input: ArrayBuffer | ArrayBufferView | string): Uint8Array {
  if (typeof input === "string") {
    return new TextEncoder().encode(input);
  }
  if (ArrayBuffer.isView(input)) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }
  return new Uint8Array(input);
}

export function byteLength(input: ArrayBuffer | ArrayBufferView | string): number {
  if (typeof input === "string") {
    return new TextEncoder().encode(input).byteLength;
  }
  return input.byteLength;
}

export async function computeDigest(
  input: ArrayBuffer | ArrayBufferView | string,
  algorithm: string,
): Promise<string> {
  const canonical = canonicalDigestAlgorithm(algorithm);
  const webCryptoName = WEB_CRYPTO_NAMES[canonical];
  if (!webCryptoName) {
    throw new Error(`Unsupported digest algorithm: ${algorithm}`);
  }
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error("Web Crypto subtle.digest is unavailable");
  }
  const bytes = toBytes(input);
  const buffer = await subtle.digest(
    webCryptoName,
    bytes as unknown as BufferSource,
  );
  return bytesToHex(new Uint8Array(buffer));
}

export async function computeSha256(
  input: ArrayBuffer | ArrayBufferView | string,
): Promise<string> {
  return computeDigest(input, "sha-256");
}

export function expectedDigests(
  download: DownloadEvent | undefined,
  response: NetworkResponse | undefined,
): DigestSpec[] {
  const result: DigestSpec[] = [];
  const sources = [
    download?.headers,
    effectiveResponseHeaders(response),
  ];
  for (const headers of sources) {
    for (const digest of parseDigestHeaders(headers)) {
      pushUnique(result, digest);
    }
  }
  if (download?.digest) {
    pushUnique(result, parseDigestSpec(download.digest));
  }
  return result;
}

function effectiveResponseHeaders(
  response: NetworkResponse | undefined,
): Parameters<typeof getHeader>[0] {
  if (response?.headers) {
    return response.headers;
  }
  if (response) {
    for (let index = response.redirectChain.length - 1; index >= 0; index -= 1) {
      const headers = response.redirectChain[index]?.headers;
      if (headers) {
        return headers;
      }
    }
  }
  return undefined;
}

export function expectedSizes(
  download: DownloadEvent | undefined,
  response: NetworkResponse | undefined,
): { sizes: number[]; preferred?: number; sources: string[] } {
  const sizes: number[] = [];
  const sources: string[] = [];

  const add = (value: number | undefined, source: string): void => {
    if (
      typeof value === "number" &&
      Number.isFinite(value) &&
      value >= 0 &&
      !sizes.includes(value)
    ) {
      sizes.push(value);
      sources.push(source);
    }
  };

  add(download?.totalBytes, "download.totalBytes");
  add(download?.fileSize, "download.fileSize");

  const downloadContentRange = getHeader(download?.headers, "content-range");
  if (downloadContentRange) {
    const match = /\/(\d+)\s*$/.exec(downloadContentRange);
    if (match) {
      add(Number(match[1]), "download.content-range");
    }
  }
  const downloadContentLength = getHeader(download?.headers, "content-length");
  if (downloadContentLength && /^\d+$/.test(downloadContentLength.trim())) {
    add(Number(downloadContentLength.trim()), "download.content-length");
  }

  const responseHeaders = effectiveResponseHeaders(response);
  const contentEncoding = getHeader(responseHeaders, "content-encoding");
  const encoded = Boolean(contentEncoding && contentEncoding.toLowerCase() !== "identity");

  const contentRange = getHeader(responseHeaders, "content-range");
  if (contentRange) {
    const match = /\/(\d+)\s*$/.exec(contentRange);
    if (match) {
      add(Number(match[1]), "response.content-range");
    }
  }

  if (!encoded) {
    const contentLength = getHeader(responseHeaders, "content-length");
    if (contentLength && /^\d+$/.test(contentLength.trim())) {
      add(Number(contentLength.trim()), "response.content-length");
    }
  }

  if (sizes.length === 0) {
    add(download?.receivedBytes, "download.receivedBytes");
    add(download?.bytesReceived, "download.bytesReceived");
  }

  return {
    sizes,
    preferred: sizes[0],
    sources,
  };
}
