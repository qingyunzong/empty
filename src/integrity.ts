import {
  canonicalDigestAlgorithm,
  computeDigest,
  digestToHex,
  expectedDigests,
  expectedSizes,
  isSupportedDigestAlgorithm,
  parseDigestSpec,
} from "./digest.ts";
import type {
  DigestSpec,
  DownloadEvent,
  FileVerification,
  NetworkResponse,
  VerificationStatus,
} from "./types.ts";

export interface ActualFile {
  size: number;
  declaredSize?: number;
  /** Hex digests supplied by the collector or computed from bytes. */
  digests: Record<string, string>;
  suppliedDigests: DigestSpec[];
  digestConflicts?: string[];
}

export interface VerificationOptions {
  now: number;
  computeSha256: boolean;
}

export function verifyFile(
  actual: ActualFile,
  expectedDigestList: readonly DigestSpec[],
  sizes: { sizes: readonly number[]; preferred?: number },
  options: VerificationOptions,
): FileVerification {
  const readActualDigest = (algorithm: string): string | undefined => {
    if (actual.digests[algorithm]) {
      return actual.digests[algorithm];
    }
    for (const [key, value] of Object.entries(actual.digests)) {
      if (canonicalDigestAlgorithm(key) === algorithm) {
        return value;
      }
    }
    return undefined;
  };

  const reasons: string[] = [];
  const digestMatches: Record<string, boolean> = {};
  const declaredSizes = [...sizes.sizes];

  if (
    actual.declaredSize !== undefined &&
    actual.declaredSize !== actual.size
  ) {
    reasons.push(
      `completion-size-conflict: declared ${actual.declaredSize}, bytes ${actual.size}`,
    );
  }

  for (const algorithm of actual.digestConflicts ?? []) {
    reasons.push(`supplied-digest-conflict: ${algorithm}`);
  }

  let sizeMatches: boolean | undefined;
  if (sizes.preferred !== undefined) {
    sizeMatches = actual.size === sizes.preferred;
    if (!sizeMatches) {
      reasons.push(
        `size-mismatch: expected ${sizes.preferred}, wrote ${actual.size}`,
      );
    } else {
      reasons.push(`size-ok: ${actual.size}`);
    }
  } else {
    reasons.push("size-unverified: no declared length");
  }

  if (
    actual.declaredSize !== undefined &&
    actual.declaredSize !== actual.size
  ) {
    sizeMatches = false;
  }

  if (declaredSizes.length > 1 && new Set(declaredSizes).size > 1) {
    reasons.push(
      `declared-size-conflict: ${[...new Set(declaredSizes)].join(", ")}`,
    );
    // A conflicting declaration cannot prove integrity.
    sizeMatches = false;
  }

  let anyDigestExpected = false;
  let allDigestsMatch = true;
  let missingDigest = false;
  let digestChecks = 0;

  for (const expected of expectedDigestList) {
    anyDigestExpected = true;
    const algorithm = canonicalDigestAlgorithm(expected.algorithm);
    const actualDigest = readActualDigest(algorithm);
    const expectedHex = digestToHex(expected.value);

    if (!expectedHex) {
      allDigestsMatch = false;
      digestMatches[algorithm] = false;
      reasons.push(`digest-unparseable: ${algorithm}`);
      continue;
    }
    if (!actualDigest) {
      if (!isSupportedDigestAlgorithm(algorithm)) {
        reasons.push(`digest-not-computable: ${algorithm}`);
        continue;
      }
      missingDigest = true;
      digestMatches[algorithm] = false;
      reasons.push(`digest-missing: ${algorithm}`);
      continue;
    }
    digestChecks += 1;
    if (actualDigest.toLowerCase() === expectedHex) {
      digestMatches[algorithm] = true;
      reasons.push(`digest-ok: ${algorithm}`);
    } else {
      allDigestsMatch = false;
      digestMatches[algorithm] = false;
      reasons.push(`digest-mismatch: ${algorithm}`);
    }
  }

  if (!anyDigestExpected) {
    reasons.push("digest-unverified: no declared digest");
  }

  let status: VerificationStatus;
  if (sizeMatches === false && anyDigestExpected && !allDigestsMatch) {
    status = "mismatch";
  } else if (sizeMatches === false) {
    status = "size-mismatch";
  } else if (!allDigestsMatch) {
    status = "digest-mismatch";
  } else if (
    missingDigest ||
    (anyDigestExpected && digestChecks === 0) ||
    (!anyDigestExpected && sizeMatches === undefined)
  ) {
    status = "unverified";
  } else if (!anyDigestExpected) {
    // A length check is still a real integrity check.
    status = "verified";
  } else {
    status = "verified";
  }

  const verified = status === "verified";
  const sha256 = readActualDigest("sha-256");
  const normalizedDigests: Record<string, string> = {};
  for (const [algorithm, value] of Object.entries(actual.digests)) {
    normalizedDigests[canonicalDigestAlgorithm(algorithm)] ??= value;
  }

  return {
    status,
    verified,
    size: actual.size,
    digests: normalizedDigests,
    sha256,
    expectedSize: sizes.preferred,
    declaredSizes,
    expectedDigests: [...expectedDigestList],
    sizeMatches,
    digestMatches,
    reasons,
    checkedAt: options.now,
  };
}

export async function buildActualFile(input: {
  bytes?: ArrayBuffer | ArrayBufferView;
  content?: string;
  size?: number;
  sha256?: string;
  digest?: string | DigestSpec;
  digests?: readonly DigestSpec[] | Readonly<Record<string, string>>;
  algorithms?: readonly string[];
  computeSha256: boolean;
}): Promise<ActualFile> {
  const suppliedDigests: DigestSpec[] = [];
  const digestConflicts: string[] = [];
  const digests: Record<string, string> = {};

  const add = (spec: DigestSpec | undefined): void => {
    if (!spec) {
      return;
    }
    const algorithm = canonicalDigestAlgorithm(spec.algorithm);
    const hex = digestToHex(spec.value);
    if (!hex) {
      return;
    }
    suppliedDigests.push({ algorithm, value: hex });
    digests[algorithm] ??= hex;
  };

  if (input.sha256) {
    add({
      algorithm: "sha-256",
      value: input.sha256.replace(/^sha-?256\s*[:=]\s*/i, ""),
    });
  }
  if (input.digest) {
    add(
      typeof input.digest === "string"
        ? parseDigestSpec(input.digest)
        : input.digest,
    );
  }
  const digestSpecs = Array.isArray(input.digests)
    ? input.digests
    : Object.entries(input.digests ?? {}).map(([algorithm, value]) => ({
        algorithm,
        value,
      }));
  for (const spec of digestSpecs) {
    add(spec);
  }

  const source = input.bytes ?? input.content;
  if (source !== undefined) {
    const algorithms = new Set<string>();
    if (input.computeSha256) {
      algorithms.add("sha-256");
    }
    for (const algorithm of Object.keys(digests)) {
      algorithms.add(algorithm);
    }
    for (const algorithm of input.algorithms ?? []) {
      algorithms.add(canonicalDigestAlgorithm(algorithm));
    }
    for (const algorithm of algorithms) {
      try {
        const computed = await computeDigest(source, algorithm);
        if (digests[algorithm] && digests[algorithm] !== computed) {
          digestConflicts.push(algorithm);
        }
        digests[algorithm] = computed;
      } catch {
        // Unsupported algorithms (for example MD5 in Web Crypto) stay absent.
      }
    }
  }

  const size =
    source === undefined
      ? (input.size ?? 0)
      : typeof source === "string"
        ? new TextEncoder().encode(source).byteLength
        : source.byteLength;

  return {
    size,
    declaredSize: source === undefined ? undefined : input.size,
    digests,
    suppliedDigests,
    digestConflicts,
  };
}

export function computeExpected(
  download: DownloadEvent | undefined,
  response: NetworkResponse | undefined,
): {
  sizes: { sizes: number[]; preferred?: number; sources: string[] };
  digests: DigestSpec[];
} {
  return {
    sizes: expectedSizes(download, response),
    digests: expectedDigests(download, response),
  };
}

export { verifyFile as checkFileIntegrity };
