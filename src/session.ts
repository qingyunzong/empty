import { deferredAcceptance } from "./algorithm.js";
import { enumerateStableMatchings, type EnumerationResult } from "./enumerate.js";
import { buildMarket, DEFAULT_LIMITS, type Market, type MarketLimits } from "./market.js";
import { certify, type Certificate } from "./stability.js";
import type { MarketInput } from "./types.js";

export interface SolveOptions {
  enumerate?: boolean;
  maxEnumerationNodes?: number;
}

export interface EnumerationSummary extends EnumerationResult {
  algorithmMatchingIsStable: boolean;
  algorithmMatchingInStableSet: boolean;
}

export interface SolveResult {
  matching: Record<string, string>;
  certificate: Certificate;
  enumeration?: EnumerationSummary;
}

export class AdmissionsSession {
  private input: MarketInput;
  private readonly limits: MarketLimits;
  private market: Market;

  constructor(input: MarketInput, limits: MarketLimits = DEFAULT_LIMITS) {
    this.limits = limits;
    this.input = structuredClone(input);
    this.market = buildMarket(this.input, this.limits);
  }

  solve(options: SolveOptions = {}): SolveResult {
    this.market = buildMarket(this.input, this.limits);
    const assignment = deferredAcceptance(this.market);
    const certificate = certify(this.market, assignment);
    const result: SolveResult = { matching: certificate.matching, certificate };

    if (options.enumerate === true) {
      const enumeration = enumerateStableMatchings(this.market, options.maxEnumerationNodes);
      const key = JSON.stringify(result.matching);
      const inStableSet = enumeration.stableMatchings.some(
        (record) => JSON.stringify(record) === key,
      );
      result.enumeration = {
        ...enumeration,
        algorithmMatchingIsStable: certificate.stable,
        algorithmMatchingInStableSet: inStableSet,
      };
    }
    return result;
  }

  withdrawApplicant(applicantId: string): void {
    const before = this.input.applicants.length;
    this.input.applicants = this.input.applicants.filter((a) => a.id !== applicantId);
    if (this.input.applicants.length === before) {
      throw new Error(`unknown applicant "${applicantId}"`);
    }
    for (const institution of this.input.institutions) {
      institution.prefers = institution.prefers
        .map((group) => group.filter((id) => id !== applicantId))
        .filter((group) => group.length > 0);
    }
  }

  withdrawApplication(applicantId: string, institutionId: string): void {
    const applicant = this.input.applicants.find((a) => a.id === applicantId);
    if (applicant === undefined) {
      throw new Error(`unknown applicant "${applicantId}"`);
    }
    const had = applicant.prefers.some((group) => group.includes(institutionId));
    if (!had) {
      throw new Error(`applicant "${applicantId}" has no application to "${institutionId}"`);
    }
    applicant.prefers = applicant.prefers
      .map((group) => group.filter((id) => id !== institutionId))
      .filter((group) => group.length > 0);
  }
}

export function createSession(input: MarketInput, limits?: MarketLimits): AdmissionsSession {
  return new AdmissionsSession(input, limits);
}
