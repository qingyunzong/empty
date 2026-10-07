import { createHash } from "node:crypto";
import type { Rational } from "./rational.ts";
import { make, parse as parseRational, toString as ratToString } from "./rational.ts";
import type { Sample } from "./enumerate.ts";
import {
  STATISTIC_ID,
  TAIL_ID,
  enumerateCompressed,
  enumerateNaive,
  groupMultiplicities,
  scaleSamples,
  validateSamples,
} from "./enumerate.ts";

export interface CertificateVerification {
  readonly engine: "naive-enumeration";
  readonly tailCount: string;
  readonly totalAssignments: string;
  readonly matchesCompressed: boolean;
}

export interface Certificate {
  readonly version: 1;
  readonly statistic: typeof STATISTIC_ID;
  readonly tail: typeof TAIL_ID;
  readonly samples: readonly { readonly id: string; readonly diff: string }[];
  readonly sampleCount: number;
  readonly zeroCount: number;
  readonly nonzeroCount: number;
  readonly observedSum: string;
  readonly observedAbsMean: string;
  readonly groups: readonly { readonly absValue: string; readonly multiplicity: number }[];
  readonly totalAssignments: string;
  readonly tailCount: string;
  readonly pValue: string;
  readonly verification: CertificateVerification;
  readonly checksum: string;
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`);
  return `{${entries.join(",")}}`;
}

export function certificateChecksum(cert: Omit<Certificate, "checksum">): string {
  return createHash("sha256").update(canonicalize(cert)).digest("hex");
}

export function analyze(samples: readonly Sample[]): Certificate {
  validateSamples(samples);
  const compressed = enumerateCompressed(samples);
  const naive = enumerateNaive(samples);
  const data = scaleSamples(samples);
  const n = BigInt(samples.length);
  const observedAbs = data.observedSumScaled < 0n ? -data.observedSumScaled : data.observedSumScaled;
  const observedAbsMean: Rational = make(observedAbs, data.scale * n);
  const pValue: Rational = make(compressed.tailCount, compressed.totalAssignments);
  const groups = [...groupMultiplicities(samples)].map(([absValue, multiplicity]) => ({
    absValue,
    multiplicity,
  }));
  const body: Omit<Certificate, "checksum"> = {
    version: 1,
    statistic: STATISTIC_ID,
    tail: TAIL_ID,
    samples: samples.map((s) => ({ id: s.id, diff: ratToString(s.diff) })),
    sampleCount: samples.length,
    zeroCount: data.zeroCount,
    nonzeroCount: data.absNonzero.length,
    observedSum: ratToString(make(data.observedSumScaled, data.scale)),
    observedAbsMean: ratToString(observedAbsMean),
    groups,
    totalAssignments: compressed.totalAssignments.toString(),
    tailCount: compressed.tailCount.toString(),
    pValue: ratToString(pValue),
    verification: {
      engine: "naive-enumeration",
      tailCount: naive.tailCount.toString(),
      totalAssignments: naive.totalAssignments.toString(),
      matchesCompressed:
        naive.tailCount === compressed.tailCount &&
        naive.totalAssignments === compressed.totalAssignments,
    },
  };
  return { ...body, checksum: certificateChecksum(body) };
}

export interface VerifyReport {
  readonly ok: boolean;
  readonly checks: readonly { readonly name: string; readonly ok: boolean; readonly detail: string }[];
}

export function verifyCertificate(cert: Certificate): VerifyReport {
  const checks: { name: string; ok: boolean; detail: string }[] = [];
  const { checksum, ...body } = cert;
  const recomputed = certificateChecksum(body);
  checks.push({
    name: "checksum",
    ok: recomputed === checksum,
    detail: recomputed === checksum ? "checksum matches" : `expected ${recomputed}, found ${checksum}`,
  });
  const samples: Sample[] = cert.samples.map((s) => ({ id: s.id, diff: parseRational(s.diff) }));
  const naive = enumerateNaive(samples);
  const countsOk =
    naive.tailCount.toString() === cert.tailCount &&
    naive.totalAssignments.toString() === cert.totalAssignments;
  checks.push({
    name: "independent-naive-enumeration",
    ok: countsOk,
    detail: countsOk
      ? "naive enumeration reproduces certified counts"
      : `naive gives ${naive.tailCount}/${naive.totalAssignments}, certificate claims ${cert.tailCount}/${cert.totalAssignments}`,
  });
  const pOk = ratToString(make(BigInt(cert.tailCount), BigInt(cert.totalAssignments))) === cert.pValue;
  checks.push({
    name: "p-value-consistency",
    ok: pOk,
    detail: pOk ? "p equals tail/total" : "pValue field inconsistent with counts",
  });
  return { ok: checks.every((c) => c.ok), checks };
}
