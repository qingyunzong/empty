"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_DP_TABLE_LIMIT = exports.DEFAULT_VERIFY_LIMIT = exports.MAX_GROUPS = void 0;
exports.normalizeInput = normalizeInput;
exports.resolveVersion = resolveVersion;
exports.isActiveAt = isActiveAt;
exports.activeSamples = activeSamples;
exports.buildOptions = buildOptions;
exports.lexCompare = lexCompare;
exports.solveDp = solveDp;
exports.exhaustiveOptimum = exhaustiveOptimum;
exports.calibrate = calibrate;
exports.MAX_GROUPS = 8;
exports.DEFAULT_VERIFY_LIMIT = 2000000;
exports.DEFAULT_DP_TABLE_LIMIT = 50000;
function fail(message) {
    throw new Error(message);
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function asNonNegativeInt(value, field) {
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
        fail(`field "${field}" must be a non-negative integer, got ${JSON.stringify(value)}`);
    }
    return value;
}
function normalizeInput(raw) {
    if (!isRecord(raw))
        fail("input must be a JSON object");
    const budget = asNonNegativeInt(raw.budget, "budget");
    let version;
    if (raw.version !== undefined)
        version = asNonNegativeInt(raw.version, "version");
    if (!Array.isArray(raw.groups))
        fail('field "groups" must be an array');
    if (raw.groups.length < 1 || raw.groups.length > exports.MAX_GROUPS) {
        fail(`group count must be between 1 and ${exports.MAX_GROUPS}, got ${raw.groups.length}`);
    }
    const groups = raw.groups.map((g, gi) => {
        if (!isRecord(g))
            fail(`groups[${gi}] must be an object`);
        if (g.name !== undefined && typeof g.name !== "string")
            fail(`groups[${gi}].name must be a string`);
        if (g.samples !== undefined && !Array.isArray(g.samples))
            fail(`groups[${gi}].samples must be an array`);
        const samples = (g.samples ?? []).map((s, si) => {
            const where = `groups[${gi}].samples[${si}]`;
            if (!isRecord(s))
                fail(`${where} must be an object`);
            if (typeof s.score !== "number" || !Number.isInteger(s.score)) {
                fail(`${where}.score must be an integer, got ${JSON.stringify(s.score)}`);
            }
            if (s.label !== true && s.label !== false && s.label !== 0 && s.label !== 1) {
                fail(`${where}.label must be true/false or 1/0, got ${JSON.stringify(s.label)}`);
            }
            if (s.id !== undefined && typeof s.id !== "string")
                fail(`${where}.id must be a string`);
            let since;
            let until;
            if (s.since !== undefined)
                since = asNonNegativeInt(s.since, `${where}.since`);
            if (s.until !== undefined)
                until = asNonNegativeInt(s.until, `${where}.until`);
            if (since !== undefined && until !== undefined && since >= until) {
                fail(`${where}: since (${since}) must be < until (${until})`);
            }
            return { id: s.id, score: s.score, label: s.label, since, until };
        });
        return { name: g.name, samples };
    });
    return { budget, version, groups };
}
function resolveVersion(input) {
    if (input.version !== undefined)
        return input.version;
    let max = 0;
    for (const g of input.groups) {
        for (const s of g.samples ?? []) {
            if (s.since !== undefined)
                max = Math.max(max, s.since);
            if (s.until !== undefined)
                max = Math.max(max, s.until);
        }
    }
    return max;
}
function isActiveAt(sample, version) {
    const since = sample.since ?? 0;
    return since <= version && (sample.until === undefined || version < sample.until);
}
function activeSamples(group, version, groupIndex) {
    return (group.samples ?? [])
        .filter((s) => isActiveAt(s, version))
        .map((s, si) => ({
        id: s.id ?? `g${groupIndex}s${si}`,
        score: s.score,
        label: s.label === true || s.label === 1,
    }));
}
/**
 * Candidate thresholds for a group: every distinct score (accept = score >= t)
 * plus maxScore + 1 (reject all). Any integer threshold outside this set is
 * outcome-equivalent to one inside, so this is the canonical domain; tied
 * scores always share a decision because acceptance depends only on score.
 */
function buildOptions(samples) {
    if (samples.length === 0)
        return [{ threshold: 0, tp: 0, fp: 0, tn: 0, fn: 0 }];
    const distinct = [...new Set(samples.map((s) => s.score))].sort((a, b) => a - b);
    const thresholds = [...distinct, distinct[distinct.length - 1] + 1];
    return thresholds.map((t) => {
        const c = { tp: 0, fp: 0, tn: 0, fn: 0 };
        for (const s of samples) {
            const accepted = s.score >= t;
            if (accepted && s.label)
                c.tp++;
            else if (accepted)
                c.fp++;
            else if (s.label)
                c.fn++;
            else
                c.tn++;
        }
        return { threshold: t, ...c };
    });
}
function lexCompare(a, b) {
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) {
        if (a[i] !== b[i])
            return a[i] < b[i] ? -1 : 1;
    }
    return a.length - b.length;
}
/**
 * Suffix DP: dp[i][b] = minimum total FN over groups i..n-1 with FP budget b.
 * Reconstruction walks groups in order and greedily takes the smallest
 * threshold that still admits an optimal completion, which yields the
 * lexicographically smallest optimal threshold vector.
 */
function solveDp(optionsPerGroup, budget) {
    const n = optionsPerGroup.length;
    const totalNegatives = optionsPerGroup.reduce((acc, opts) => acc + (opts.length > 0 ? opts[opts.length - 1].tn : 0), 0);
    const B = Math.min(budget, totalNegatives);
    const dp = Array.from({ length: n + 1 }, () => new Array(B + 1).fill(0));
    for (let i = n - 1; i >= 0; i--) {
        for (let b = 0; b <= B; b++) {
            let best = Infinity;
            for (const opt of optionsPerGroup[i]) {
                if (opt.fp > b)
                    continue;
                const value = opt.fn + dp[i + 1][b - opt.fp];
                if (value < best)
                    best = value;
            }
            dp[i][b] = best;
        }
    }
    const chosen = [];
    let remaining = B;
    for (let i = 0; i < n; i++) {
        const target = dp[i][remaining];
        let pick = -1;
        for (let k = 0; k < optionsPerGroup[i].length; k++) {
            const o = optionsPerGroup[i][k];
            if (o.fp <= remaining && o.fn + dp[i + 1][remaining - o.fp] === target) {
                pick = k;
                break;
            }
        }
        if (pick < 0)
            fail(`internal error: no feasible option for group ${i}`);
        chosen.push(pick);
        remaining -= optionsPerGroup[i][pick].fp;
    }
    return { dp, effectiveBudget: B, chosen };
}
function exhaustiveOptimum(optionsPerGroup, budget, limit) {
    let combinations = 1;
    for (const opts of optionsPerGroup)
        combinations *= opts.length;
    if (!Number.isFinite(combinations) || combinations > limit) {
        return {
            performed: false,
            combinations,
            reason: `combination count ${combinations} exceeds verify limit ${limit}`,
        };
    }
    const n = optionsPerGroup.length;
    let bestFn = Infinity;
    let bestVec = [];
    const vec = new Array(n).fill(0);
    const visit = (i, fp, fn) => {
        if (fn > bestFn)
            return;
        if (i === n) {
            if (fn < bestFn || (fn === bestFn && lexCompare(vec, bestVec) < 0)) {
                bestFn = fn;
                bestVec = vec.slice();
            }
            return;
        }
        for (const o of optionsPerGroup[i]) {
            if (fp + o.fp > budget)
                continue;
            vec[i] = o.threshold;
            visit(i + 1, fp + o.fp, fn + o.fn);
        }
    };
    visit(0, 0, 0);
    return { performed: true, combinations, optimalFn: bestFn, thresholds: bestVec };
}
function calibrate(raw, options = {}) {
    const verifyLimit = options.verifyLimit ?? exports.DEFAULT_VERIFY_LIMIT;
    const dpTableLimit = options.dpTableLimit ?? exports.DEFAULT_DP_TABLE_LIMIT;
    const input = normalizeInput(raw);
    const version = resolveVersion(input);
    const perGroup = input.groups.map((g, gi) => {
        const samples = activeSamples(g, version, gi);
        return {
            name: g.name ?? `group-${gi}`,
            samples,
            options: buildOptions(samples),
        };
    });
    const optionsPerGroup = perGroup.map((g) => g.options);
    const { dp, effectiveBudget, chosen } = solveDp(optionsPerGroup, input.budget);
    const thresholds = perGroup.map((g, i) => g.options[chosen[i]].threshold);
    const groupResults = perGroup.map((g, i) => {
        const o = g.options[chosen[i]];
        return {
            name: g.name,
            threshold: o.threshold,
            confusion: { tp: o.tp, fp: o.fp, tn: o.tn, fn: o.fn },
            sampleCount: g.samples.length,
        };
    });
    const totals = groupResults.reduce((acc, g) => ({
        tp: acc.tp + g.confusion.tp,
        fp: acc.fp + g.confusion.fp,
        tn: acc.tn + g.confusion.tn,
        fn: acc.fn + g.confusion.fn,
    }), { tp: 0, fp: 0, tn: 0, fn: 0 });
    const exhaustive = exhaustiveOptimum(optionsPerGroup, input.budget, verifyLimit);
    if (exhaustive.performed) {
        exhaustive.matchesDp =
            exhaustive.optimalFn === totals.fn && lexCompare(exhaustive.thresholds ?? [], thresholds) === 0;
    }
    const cells = (perGroup.length + 1) * (effectiveBudget + 1);
    const tableIncluded = cells <= dpTableLimit;
    const certificate = {
        method: "suffix-dp + greedy lexicographic reconstruction",
        objective: "minimize total FN subject to total FP <= budget; break ties by lexicographically smallest threshold vector",
        budget: input.budget,
        effectiveBudget,
        optimalTotalFn: totals.fn,
        totalFp: totals.fp,
        groups: perGroup.map((g, i) => ({
            name: g.name,
            options: g.options,
            chosenOptionIndex: chosen[i],
        })),
        dp: {
            dimensions: [perGroup.length + 1, effectiveBudget + 1],
            tableIncluded,
            ...(tableIncluded ? { table: dp } : {}),
        },
        exhaustive,
    };
    return { version, budget: input.budget, thresholds, totals, groups: groupResults, certificate };
}
