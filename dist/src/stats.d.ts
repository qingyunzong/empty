export declare function exactMedian(values: readonly number[]): number | null;
export declare function averageRanks(absValues: readonly number[]): number[];
export interface SignedRankCore {
    readonly n: number;
    readonly keptDiffs: ReadonlyArray<{
        readonly index: number;
        readonly diff: number;
    }>;
    readonly absRanks: ReadonlyArray<number>;
    readonly wPlus: number;
    readonly wMinus: number;
    readonly statistic: number;
    readonly extremeCount: bigint;
    readonly totalReassignments: bigint;
    readonly pValue: number;
}
export declare function wilcoxonSignedRankExact(diffs: readonly number[]): SignedRankCore | null;
