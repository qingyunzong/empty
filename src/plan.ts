/** End-to-end planning: gaps -> cover -> dependency closure -> schedule -> certificate. */

import type { PlanInput } from "./model";
import { computeGaps, type Interval } from "./gaps";
import { buildBundles, elementarySegments, minCostCover, bruteForceCover, type Bundle } from "./cover";
import { optimalSchedule, exhaustiveMinPeak } from "./schedule";

export interface CoverCertificate {
  feasible: boolean;
  reason: string | null;
  gaps: Interval[];
  segmentCount: number;
  selectedBundles: string[];
  selectedMembers: string[];
  totalBytes: number;
  packageCount: number;
  maxPackages: number;
}

export interface ScheduleStepCertificate {
  bundle: string;
  memStart: number;
  memAfterDownload: number;
  memPeak: number;
  memAfterDecode: number;
  memAfterRelease: number;
  released: string[];
}

export interface ScheduleCertificate {
  order: string[];
  steps: ScheduleStepCertificate[];
  peakMemory: number;
  lowerBound: number;
  upperBound: number;
  memoryLimit: number | null;
  withinLimit: boolean | null;
}

export interface VerificationCertificate {
  coverBruteForce: { subsetsChecked: number; totalBytes: number; matchesDP: boolean } | null;
  scheduleExhaustive: { minPeak: number; matchesDP: boolean } | null;
}

export interface Certificate {
  cover: CoverCertificate;
  dependencyClosure: { addedBundles: string[] };
  schedule: ScheduleCertificate | null;
  verification: VerificationCertificate;
}

/** Add dependency closure: bundles required only for their decode dictionaries. */
export function dependencyClosure(chosen: number[], bundles: Bundle[]): { all: number[]; added: number[] } {
  const inSet = new Set(chosen);
  const added: number[] = [];
  const queue = [...chosen];
  while (queue.length > 0) {
    const b = queue.pop()!;
    for (const d of bundles[b]!.depBundles) {
      if (!inSet.has(d)) {
        inSet.add(d);
        added.push(d);
        queue.push(d);
      }
    }
  }
  return { all: [...inSet].sort((a, b) => a - b), added };
}

export function buildPlan(input: PlanInput, verify: boolean): Certificate {
  const covers: Interval[] = input.packages.map((p) => [p.coverL, p.coverR]);
  const gaps = computeGaps(input.existing, covers);
  const bundles = buildBundles(input.packages);
  const segments = elementarySegments(gaps, bundles);
  const cover = minCostCover(segments, bundles, input.maxPackages);

  const verification: VerificationCertificate = { coverBruteForce: null, scheduleExhaustive: null };

  if (verify) {
    const bf = bruteForceCover(segments, bundles, input.maxPackages);
    if (bf) {
      verification.coverBruteForce = {
        subsetsChecked: bf.subsetsChecked,
        totalBytes: bf.feasible ? bf.totalBytes : -1,
        matchesDP: bf.feasible === cover.feasible && (!bf.feasible || bf.totalBytes === cover.totalBytes),
      };
    }
  }

  const coverCert: CoverCertificate = {
    feasible: cover.feasible,
    reason: cover.reason,
    gaps,
    segmentCount: segments.length,
    selectedBundles: cover.chosen.map((b) => bundles[b]!.key),
    selectedMembers: cover.chosen.flatMap((b) => bundles[b]!.members.map((m) => m.id)),
    totalBytes: cover.totalBytes,
    packageCount: cover.packageCount,
    maxPackages: input.maxPackages,
  };

  if (!cover.feasible) {
    return { cover: coverCert, dependencyClosure: { addedBundles: [] }, schedule: null, verification };
  }

  const closure = dependencyClosure(cover.chosen, bundles);
  const finalSet = closure.all;
  const pos = new Map<number, number>();
  finalSet.forEach((b, i) => pos.set(b, i));
  const bytes = finalSet.map((b) => bundles[b]!.bytes);
  const dict = finalSet.map((b) => bundles[b]!.dict);
  const deps = finalSet.map((b) => bundles[b]!.depBundles.map((d) => pos.get(d)!));
  const keys = finalSet.map((b) => bundles[b]!.key);

  const sched = optimalSchedule(bytes, dict, deps);

  if (verify) {
    const ex = exhaustiveMinPeak(bytes, dict, deps);
    if (ex !== null) verification.scheduleExhaustive = { minPeak: ex, matchesDP: ex === sched.peak };
  }

  const withinLimit = input.memoryLimit === null ? null : sched.peak <= input.memoryLimit;
  const scheduleCert: ScheduleCertificate = {
    order: sched.order.map((i) => keys[i]!),
    steps: sched.steps.map((s) => ({
      bundle: keys[s.pkg]!,
      memStart: s.memStart,
      memAfterDownload: s.memAfterDownload,
      memPeak: s.memPeak,
      memAfterDecode: s.memAfterDecode,
      memAfterRelease: s.memAfterRelease,
      released: s.released.map((r) => keys[r]!),
    })),
    peakMemory: sched.peak,
    lowerBound: sched.lowerBound,
    upperBound: sched.upperBound,
    memoryLimit: input.memoryLimit,
    withinLimit,
  };

  // Note: totalBytes in the cover certificate is the DP optimum for coverage;
  // the closure may add packages, reported separately.
  return {
    cover: coverCert,
    dependencyClosure: { addedBundles: closure.added.map((b) => bundles[b]!.key) },
    schedule: scheduleCert,
    verification,
  };
}
