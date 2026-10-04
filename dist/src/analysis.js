import { exactMedian, wilcoxonSignedRankExact } from "./stats.js";
export function groupKeyOf(env, inputDigest) {
    return `${env}::${inputDigest}`;
}
export function pairKeyOf(env, inputDigest, round) {
    return `${env}::${inputDigest}::${round}`;
}
export function computeGroupAnalysis(env, inputDigest, pairs, samplesById) {
    const ordered = [...pairs].sort((x, y) => x.round - y.round);
    const completeDiffs = [];
    let missingA = 0;
    let missingB = 0;
    for (const pair of ordered) {
        if (pair.a !== null && pair.b !== null) {
            completeDiffs.push(samplesById.get(pair.a).durationMs - samplesById.get(pair.b).durationMs);
        }
        else if (pair.a === null) {
            missingA++;
        }
        else {
            missingB++;
        }
    }
    const core = wilcoxonSignedRankExact(completeDiffs);
    const rankByPair = new Map();
    if (core !== null) {
        core.keptDiffs.forEach((kept, i) => {
            rankByPair.set(kept.index, core.absRanks[i]);
        });
    }
    const pairAnalyses = ordered.map((pair, index) => {
        const aSample = pair.a === null ? null : samplesById.get(pair.a);
        const bSample = pair.b === null ? null : samplesById.get(pair.b);
        const diff = aSample !== null && bSample !== null ? aSample.durationMs - bSample.durationMs : null;
        const absRank = diff !== null && diff !== 0 ? rankByPair.get(index) ?? null : null;
        return {
            round: pair.round,
            aSampleId: pair.a,
            bSampleId: pair.b,
            aMs: aSample === null ? null : aSample.durationMs,
            bMs: bSample === null ? null : bSample.durationMs,
            diff,
            absRank,
        };
    });
    let wilcoxon = null;
    if (core !== null) {
        wilcoxon = {
            n: core.n,
            zeroDiffsDropped: completeDiffs.length - core.n,
            wPlus: core.wPlus,
            wMinus: core.wMinus,
            statistic: core.statistic,
            extremeCount: core.extremeCount.toString(),
            totalReassignments: core.totalReassignments.toString(),
            pValue: core.pValue,
            evidence: core.keptDiffs.map((kept, i) => {
                const pair = ordered[kept.index];
                return {
                    aSampleId: pair.a,
                    bSampleId: pair.b,
                    diff: kept.diff,
                    absRank: core.absRanks[i],
                };
            }),
        };
    }
    return {
        env,
        inputDigest,
        pairs: pairAnalyses,
        completePairs: completeDiffs.length,
        missingA,
        missingB,
        medianDiff: exactMedian(completeDiffs),
        wilcoxon,
    };
}
