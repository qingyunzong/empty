import type { GroupAnalysis, Sample, Snapshot, VerifyReport } from "./types.js";
export declare class ValidationError extends Error {
}
export declare class DuplicateSampleIdError extends Error {
}
export declare class DuplicateRoundConflictError extends Error {
}
export declare class UnknownSampleError extends Error {
}
export declare class BenchmarkStore {
    private readonly dir;
    private version;
    private state;
    private constructor();
    static open(dir: string): BenchmarkStore;
    get currentVersion(): number;
    submit(sample: Sample): Snapshot;
    withdraw(sampleId: string): Snapshot;
    analyze(): ReadonlyArray<GroupAnalysis>;
    getSample(id: string): Sample | undefined;
    verify(): VerifyReport;
    listSnapshots(): number[];
    snapshot(version: number): Snapshot | null;
    private cloneState;
    private refreshGroup;
    private commit;
    private snapshotFiles;
    private latestSnapshotFile;
}
