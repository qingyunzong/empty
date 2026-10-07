"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.layoutBruteForce = layoutBruteForce;
const layout_1 = require("./layout");
const MAX_ENUMERATED_BOUNDARIES = 22;
/**
 * Reference implementation: enumerates every subset of allowed break
 * boundaries (full enumeration / 全切分) and picks the optimum with the same
 * tie-break rule as `layout`. Exponential — intended for verifying the DP on
 * short texts only.
 */
function layoutBruteForce(options) {
    if (options.words.length === 0) {
        return { ok: true, cost: 0, breaks: [], lines: [], hyphenations: 0 };
    }
    const built = (0, layout_1.buildModel)(options);
    if ('ok' in built)
        return built;
    const model = built;
    const N = model.atoms.length;
    const allowed = [];
    for (let b = 1; b < N; b++)
        if (model.boundary[b])
            allowed.push(b);
    if (allowed.length > MAX_ENUMERATED_BOUNDARIES) {
        throw new Error(`brute force limited to ${MAX_ENUMERATED_BOUNDARIES} break boundaries, got ${allowed.length}`);
    }
    let best = null;
    const total = 1 << allowed.length;
    for (let mask = 0; mask < total; mask++) {
        const boundaries = [];
        let hyphens = 0;
        for (let k = 0; k < allowed.length; k++) {
            if (mask & (1 << k)) {
                const b = allowed[k];
                boundaries.push(b);
                if (model.boundary[b] === 'hyphen')
                    hyphens++;
            }
        }
        if (hyphens > model.maxHyphenations)
            continue;
        // Segment atoms into lines at the chosen boundaries.
        const segments = [];
        let prev = 0;
        for (const b of boundaries) {
            segments.push([prev, b - 1]);
            prev = b;
        }
        segments.push([prev, N - 1]);
        let cost = 0;
        let feasible = true;
        for (let s = 0; s < segments.length; s++) {
            const [a, b] = segments[s];
            const lineNo = s + 1;
            const avail = (0, layout_1.availWidth)(model, lineNo);
            const isLast = s === segments.length - 1;
            const hyphenated = !isLast && model.boundary[b + 1] === 'hyphen';
            const w = (0, layout_1.lineContentWidth)(model, a, b) + (hyphenated ? model.hyphenWidth : 0);
            if (w > avail) {
                feasible = false;
                break;
            }
            const wc = model.atoms[b].word - model.atoms[a].word + 1;
            if (s === 0 && wc < model.minFirst) {
                feasible = false;
                break;
            }
            if (isLast) {
                if (wc < model.minLast) {
                    feasible = false;
                }
            }
            else {
                cost += (avail - w) * (avail - w);
            }
            if (!feasible)
                break;
        }
        if (!feasible)
            continue;
        if (!best ||
            cost < best.cost ||
            (cost === best.cost && lexLess(boundaries, best.boundaries))) {
            best = { cost, boundaries };
        }
    }
    if (!best) {
        return {
            ok: false,
            kind: 'infeasible',
            reason: 'no feasible line breaking satisfies the width, image, hyphenation and widow/orphan constraints',
        };
    }
    return (0, layout_1.assemble)(model, best);
}
function lexLess(a, b) {
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) {
        if (a[i] !== b[i])
            return a[i] < b[i];
    }
    return a.length < b.length;
}
