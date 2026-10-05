import { enumerateCover, solveCover, type CoverAssignment } from "./cover.js";
import { intersect, normalize, subtract, totalLength } from "./intervals.js";
import { bruteForcePeak, planSchedule, type ScheduleEvent } from "./schedule.js";
import type { Interval, Problem } from "./types.js";

export interface CoverageCertificate {
  feasible: boolean;
  reason: string;
  gaps: Interval[];
  gapBytes: number;
  selected: string[];
  totalBytes: number;
  maxPackages: number;
  assignment: CoverAssignment[];
  enumeration: {
    checked: boolean;
    reason: string;
    subsetsTried: number;
    bestBytes: number;
    matchesSolver: boolean;
  };
}

export interface ScheduleCertificate {
  feasible: boolean;
  reason: string;
  required: string[];
  extraDependencies: string[];
  order: string[];
  events: ScheduleEvent[];
  peak: number;
  lowerBound: number;
  upperBound: number;
  exact: boolean;
  memoryLimit: number;
  totalDownloadBytes: number;
  bruteForce: {
    checked: boolean;
    bestPeak: number | null;
    matchesSolver: boolean;
  };
}

export interface Certificate {
  version: 1;
  coverage: CoverageCertificate;
  schedule: ScheduleCertificate | null;
}

export interface PlanOptions {
  /** Cross-check the cover solver by enumerating all subsets (small inputs). */
  enumerate: boolean;
  /** Cross-check the scheduler by enumerating all decode orders (small inputs). */
  bruteForce: boolean;
}

/** Build a full coverage + download/decode certificate for a problem. */
export function buildCertificate(problem: Problem, opts: PlanOptions): Certificate {
  const cover = solveCover(problem);
  const gaps = subtract(problem.range, problem.receiver);

  let enumeration: CoverageCertificate["enumeration"] = {
    checked: false, reason: "disabled", subsetsTried: 0,
    bestBytes: Number.POSITIVE_INFINITY, matchesSolver: false,
  };
  if (opts.enumerate) {
    const en = enumerateCover(problem);
    enumeration = {
      checked: en.checked,
      reason: en.reason,
      subsetsTried: en.subsetsTried,
      bestBytes: en.feasible ? en.bestBytes : Number.POSITIVE_INFINITY,
      matchesSolver: en.checked
        ? (en.feasible === cover.feasible && (!en.feasible || en.bestBytes === cover.totalBytes))
        : false,
    };
  }

  const coverage: CoverageCertificate = {
    feasible: cover.feasible,
    reason: cover.reason,
    gaps,
    gapBytes: totalLength(gaps),
    selected: cover.selected,
    totalBytes: cover.totalBytes,
    maxPackages: problem.maxPackages,
    assignment: cover.assignment,
    enumeration,
  };
  if (!cover.feasible) return { version: 1, coverage, schedule: null };

  const sched = planSchedule(problem, cover.selected);
  let brute: ScheduleCertificate["bruteForce"] = {
    checked: false, bestPeak: null, matchesSolver: false,
  };
  if (opts.bruteForce) {
    const bf = bruteForcePeak(problem, cover.selected);
    brute = {
      checked: bf !== null,
      bestPeak: bf,
      matchesSolver: bf !== null && bf === sched.peak,
    };
  }
  const schedule: ScheduleCertificate = {
    feasible: sched.feasible,
    reason: sched.reason,
    required: sched.required,
    extraDependencies: sched.extraDependencies,
    order: sched.order,
    events: sched.events,
    peak: sched.peak,
    lowerBound: sched.lowerBound,
    upperBound: sched.upperBound,
    exact: sched.exact,
    memoryLimit: sched.memoryLimit,
    totalDownloadBytes: sched.totalDownloadBytes,
    bruteForce: brute,
  };
  return { version: 1, coverage, schedule };
}

/**
 * Independently verify a certificate against its problem definition.
 * Returns a list of errors; an empty list means the certificate is valid.
 */
export function verifyCertificate(problem: Problem, cert: Certificate): string[] {
  const errors: string[] = [];
  const byId = new Map(problem.packages.map((p) => [p.id, p]));
  const gaps = subtract(problem.range, problem.receiver);
  const cov = cert.coverage;

  if (JSON.stringify(cov.gaps) !== JSON.stringify(gaps)) {
    errors.push("coverage.gaps does not match range minus receiver");
  }
  if (!cov.feasible) {
    // Cross-check the infeasibility claim on small inputs.
    const en = enumerateCover(problem);
    if (en.checked && en.feasible) errors.push("certificate claims infeasible cover but enumeration found one");
    return errors;
  }

  // Selection validity: known ids, within budget, cost counted once each.
  const selected = cov.selected;
  if (new Set(selected).size !== selected.length) errors.push("duplicate ids in selected");
  for (const id of selected) if (!byId.has(id)) errors.push(`selected unknown package ${id}`);
  if (selected.length > problem.maxPackages) {
    errors.push(`selected ${selected.length} packages > maxPackages ${problem.maxPackages}`);
  }
  const cost = selected.reduce((acc, id) => acc + (byId.get(id)?.bytes ?? 0), 0);
  if (cost !== cov.totalBytes) errors.push(`totalBytes ${cov.totalBytes} != sum of selected bytes ${cost}`);

  // Every gap must be covered by at least one selected package.
  const selCovers = selected.map((id) => intersect(normalize(byId.get(id)!.cover), gaps));
  for (const gap of gaps) {
    const leftover = subtract(gap, selCovers.flat());
    if (leftover.length > 0) {
      errors.push(`gap [${gap.start},${gap.end}) not fully covered; missing ${JSON.stringify(leftover)}`);
    }
  }

  // Assignment consistency: entries tile the gaps and list covering packages.
  const assigned = normalize(cov.assignment.map((a) => a.interval));
  if (JSON.stringify(assigned) !== JSON.stringify(gaps)) {
    errors.push("assignment intervals do not tile the gaps");
  }
  for (const a of cov.assignment) {
    if (a.packages.length === 0) errors.push(`assignment [${a.interval.start},${a.interval.end}) has no package`);
    for (const id of a.packages) {
      if (!selected.includes(id)) errors.push(`assignment references non-selected package ${id}`);
      const covers = byId.get(id)?.cover ?? [];
      const mid = (a.interval.start + a.interval.end) / 2;
      if (!covers.some((iv) => iv.start <= mid && mid < iv.end)) {
        errors.push(`package ${id} does not cover assigned interval [${a.interval.start},${a.interval.end})`);
      }
    }
  }

  // Optimality cross-check on small inputs.
  const en = enumerateCover(problem);
  if (en.checked) {
    if (!en.feasible) errors.push("enumeration found no cover but certificate claims one");
    else if (en.bestBytes !== cov.totalBytes) {
      errors.push(`totalBytes ${cov.totalBytes} is not optimal; enumeration found ${en.bestBytes}`);
    }
  }

  // Schedule checks.
  const sched = cert.schedule;
  if (!sched) {
    errors.push("missing schedule certificate");
    return errors;
  }
  const required = new Set(sched.required);
  for (const id of selected) {
    if (!required.has(id)) errors.push(`selected package ${id} missing from schedule.required`);
  }
  for (const id of sched.required) {
    if (!byId.has(id)) errors.push(`schedule requires unknown package ${id}`);
    for (const dep of byId.get(id)?.needs ?? []) {
      if (!required.has(dep)) errors.push(`dependency ${dep} of ${id} missing from schedule.required`);
    }
  }
  // Order: permutation of required, dependencies decoded first.
  if (JSON.stringify([...sched.order].sort()) !== JSON.stringify([...sched.required].sort())) {
    errors.push("schedule.order is not a permutation of schedule.required");
  }
  const decodedBefore = new Set<string>();
  for (const id of sched.order) {
    for (const dep of byId.get(id)?.needs ?? []) {
      if (!decodedBefore.has(dep)) errors.push(`package ${id} decoded before its dependency ${dep}`);
    }
    decodedBefore.add(id);
  }
  // Replay the event trace: memories must match and never exceed the peak.
  const dependents = new Map<string, string[]>();
  for (const id of sched.required) dependents.set(id, []);
  for (const id of sched.required) {
    for (const dep of byId.get(id)!.needs) dependents.get(dep)!.push(id);
  }
  const decoded = new Set<string>();
  const released = new Set<string>();
  let recomputedPeak = 0;
  let step = 0;
  const residentNow = (): number => {
    let mem = 0;
    for (const id of decoded) {
      if (released.has(id)) continue;
      if (dependents.get(id)!.some((k) => !decoded.has(k))) mem += byId.get(id)!.dictBytes;
    }
    return mem;
  };
  for (const ev of sched.events) {
    step++;
    if (!byId.has(ev.package)) { errors.push(`event ${step}: unknown package ${ev.package}`); continue; }
    let memory: number;
    if (ev.action === "download") {
      memory = residentNow() + byId.get(ev.package)!.bytes;
    } else if (ev.action === "decode") {
      memory = residentNow() + byId.get(ev.package)!.bytes + byId.get(ev.package)!.dictBytes;
      decoded.add(ev.package);
    } else {
      released.add(ev.package);
      memory = residentNow();
    }
    if (memory !== ev.memory) {
      errors.push(`event ${step} (${ev.action} ${ev.package}): memory ${ev.memory} != recomputed ${memory}`);
    }
    recomputedPeak = Math.max(recomputedPeak, memory);
  }
  if (recomputedPeak !== sched.peak) {
    errors.push(`peak ${sched.peak} != recomputed peak ${recomputedPeak}`);
  }
  if (!(sched.lowerBound <= sched.peak && sched.peak <= sched.upperBound)) {
    errors.push(`bounds violated: lowerBound ${sched.lowerBound} <= peak ${sched.peak} <= upperBound ${sched.upperBound}`);
  }
  // Recompute the lower bound independently.
  let lb = 0;
  for (const id of sched.required) {
    const p = byId.get(id)!;
    let cur = p.bytes + p.dictBytes;
    for (const dep of p.needs) cur += byId.get(dep)!.dictBytes;
    lb = Math.max(lb, cur);
  }
  if (lb !== sched.lowerBound) errors.push(`lowerBound ${sched.lowerBound} != recomputed ${lb}`);
  if (sched.feasible && sched.peak > problem.memoryLimit) {
    errors.push(`schedule claims feasible but peak ${sched.peak} > memoryLimit ${problem.memoryLimit}`);
  }
  if (!sched.feasible && sched.peak <= problem.memoryLimit) {
    errors.push("schedule claims infeasible but peak fits within memoryLimit");
  }
  // Exhaustive small-state-graph cross-check of the peak.
  const bf = bruteForcePeak(problem, selected);
  if (bf !== null && bf !== sched.peak) {
    errors.push(`peak ${sched.peak} != brute-force optimum ${bf}`);
  }
  const dl = sched.required.reduce((acc, id) => acc + byId.get(id)!.bytes, 0);
  if (dl !== sched.totalDownloadBytes) {
    errors.push(`totalDownloadBytes ${sched.totalDownloadBytes} != recomputed ${dl}`);
  }
  return errors;
}
