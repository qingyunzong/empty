function cell(value) {
    return value === null ? "" : String(value);
}
export function formatGroupReport(analysis) {
    const lines = [];
    lines.push(`group env=${analysis.env} digest=${analysis.inputDigest}`);
    lines.push("round | A sample | A ms | B sample | B ms | diff | |diff| rank");
    for (const pair of analysis.pairs) {
        lines.push([
            pair.round,
            cell(pair.aSampleId),
            cell(pair.aMs),
            cell(pair.bSampleId),
            cell(pair.bMs),
            cell(pair.diff),
            cell(pair.absRank),
        ].join(" | "));
    }
    lines.push(`complete=${analysis.completePairs} missingA=${analysis.missingA} missingB=${analysis.missingB} medianDiff=${cell(analysis.medianDiff)}`);
    if (analysis.wilcoxon !== null) {
        const w = analysis.wilcoxon;
        lines.push(`wilcoxon n=${w.n} zeroDropped=${w.zeroDiffsDropped} W+=${w.wPlus} W-=${w.wMinus} |W+-W-|=${w.statistic}`);
        lines.push(`exact two-sided p=${w.pValue} (${w.extremeCount}/${w.totalReassignments} sign reassignments)`);
        for (const ev of w.evidence) {
            lines.push(`evidence A=${ev.aSampleId} B=${ev.bSampleId} diff=${ev.diff} rank=${ev.absRank}`);
        }
    }
    else {
        lines.push("wilcoxon n=0 (no non-zero paired differences)");
    }
    return lines.join("\n");
}
export function formatReport(analyses) {
    return analyses.map(formatGroupReport).join("\n\n");
}
