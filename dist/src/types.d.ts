export type Arm = "A" | "B";
export interface Sample {
    readonly id: string;
    readonly env: string;
    readonly inputDigest: string;
    readonly round: number;
    readonly arm: Arm;
    readonly durationMs: number;
}
export interface PairRecord {
    readonly env: string;
    readonly inputDigest: string;
    readonly round: number;
    readonly a: string | null;
    readonly b: string | null;
}
export interface PairAnalysis {
    readonly round: number;
    readonly aSampleId: string | null;
    readonly bSampleId: string | null;
    readonly aMs: number | null;
    readonly bMs: number | null;
    readonly diff: number | null;
    readonly absRank: number | null;
}
export interface WilcoxonResult {
    readonly n: number;
    readonly zeroDiffsDropped: number;
    readonly wPlus: number;
    readonly wMinus: number;
    readonly statistic: number;
    readonly extremeCount: string;
    readonly totalReassignments: string;
    readonly pValue: number;
    readonly evidence: ReadonlyArray<{
        readonly aSampleId: string;
        readonly bSampleId: string;
        readonly diff: number;
        readonly absRank: number;
    }>;
}
export interface GroupAnalysis {
    readonly env: string;
    readonly inputDigest: string;
    readonly pairs: ReadonlyArray<PairAnalysis>;
    readonly completePairs: number;
    readonly missingA: number;
    readonly missingB: number;
    readonly medianDiff: number | null;
    readonly wilcoxon: WilcoxonResult | null;
}
export interface Snapshot {
    readonly version: number;
    readonly createdAt: string;
    readonly samples: ReadonlyArray<Sample>;
    readonly analyses: ReadonlyArray<GroupAnalysis>;
}
export interface VerifyReport {
    readonly checkedGroups: number;
    readonly correctedGroups: ReadonlyArray<string>;
    readonly snapshotVersion: number | null;
}
