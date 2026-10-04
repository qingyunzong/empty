import type { GroupAnalysis, PairRecord, Sample } from "./types.js";
export declare function groupKeyOf(env: string, inputDigest: string): string;
export declare function pairKeyOf(env: string, inputDigest: string, round: number): string;
export declare function computeGroupAnalysis(env: string, inputDigest: string, pairs: ReadonlyArray<PairRecord>, samplesById: ReadonlyMap<string, Sample>): GroupAnalysis;
