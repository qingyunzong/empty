"use strict";
/**
 * Exact solver for systems of single-variable linear inequalities and
 * congruences over signed 64-bit domains.
 *
 * Strict inequalities are handled by exact integer shifts
 * (a*x + k < 0  <=>  a*x + (k+1) <= 0); all divisions are floor/ceil
 * divisions on bigint. No floating point is ever involved.
 *
 * The solution set of each variable is a union of arithmetic
 * progressions ("step intervals"): the congruences collapse via CRT to a
 * single progression x === R (mod M), inequalities clip it to [L, U],
 * and each disequality removes a single point, splitting intervals.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.SolveError = void 0;
exports.solveVariable = solveVariable;
exports.solveProblem = solveProblem;
const bigint_math_1 = require("./bigint-math");
class SolveError extends Error {
    constructor(message) {
        super(message);
        this.name = "SolveError";
    }
}
exports.SolveError = SolveError;
function compareConst(k, op) {
    switch (op) {
        case "<=":
            return k <= 0n;
        case "<":
            return k < 0n;
        case ">=":
            return k >= 0n;
        case ">":
            return k > 0n;
        case "==":
            return k === 0n;
        case "!=":
            return k !== 0n;
    }
}
function constraintLabel(c) {
    return `"${c.source}" (line ${c.line})`;
}
function unsat(variable, domain, bounds, certificate) {
    return {
        variable,
        domain,
        bounds,
        status: "unsat",
        intervals: [],
        solutionCount: 0n,
        certificate,
    };
}
function solveVariable(name, domain, constraints) {
    let lo = domain.lo;
    let hi = domain.hi;
    let loSource = `domain of ${name}`;
    let hiSource = `domain of ${name}`;
    const excluded = [];
    const congruences = [];
    const bounds = () => ({ lo, hi });
    for (const c of constraints) {
        const a = c.expr.coeffs.get(name) ?? 0n;
        const k = c.expr.constant;
        if (c.kind === "cong") {
            // a*x + k === 0 (mod m)
            const m = c.modulus;
            const am = (0, bigint_math_1.mod)(a, m);
            const km = (0, bigint_math_1.mod)(k, m);
            if (am === 0n) {
                if (km !== 0n) {
                    return unsat(name, domain, bounds(), {
                        type: "constant-contradiction",
                        constraint: constraintLabel(c),
                        detail: `constant ${km} is not 0 mod ${m}`,
                    });
                }
                continue;
            }
            const g = (0, bigint_math_1.gcd)(am, m);
            if (km % g !== 0n) {
                return unsat(name, domain, bounds(), {
                    type: "congruence-unsolvable",
                    constraint: constraintLabel(c),
                    gcd: g,
                    detail: `gcd(${am}, ${m}) = ${g} does not divide ${km}`,
                });
            }
            const a1 = am / g;
            const m1 = m / g;
            const k1 = km / g;
            if (m1 === 1n)
                continue; // trivially true
            const inv = (0, bigint_math_1.modInverse)(a1, m1);
            if (inv === null)
                throw new SolveError("internal error: missing modular inverse");
            congruences.push({ cong: { residue: (0, bigint_math_1.mod)(-k1 * inv, m1), modulus: m1 }, source: constraintLabel(c) });
            continue;
        }
        // Inequality family: a*x + k OP 0
        if (a === 0n) {
            if (!compareConst(k, c.op)) {
                return unsat(name, domain, bounds(), {
                    type: "constant-contradiction",
                    constraint: constraintLabel(c),
                    detail: `constant ${k} ${c.op} 0 is false`,
                });
            }
            continue;
        }
        if (c.op === "!=") {
            if (k % a === 0n)
                excluded.push(-k / a);
            continue; // otherwise never equal: constraint always holds
        }
        // Normalize to upper-bound form A*x + K <= 0, possibly twice for ==.
        const upperForms = [];
        switch (c.op) {
            case "<=":
                upperForms.push({ A: a, K: k });
                break;
            case "<":
                upperForms.push({ A: a, K: k + 1n }); // exact strict handling
                break;
            case ">=":
                upperForms.push({ A: -a, K: -k });
                break;
            case ">":
                upperForms.push({ A: -a, K: 1n - k }); // a*x + k > 0  <=>  -a*x + (1-k) <= 0
                break;
            case "==":
                upperForms.push({ A: a, K: k }, { A: -a, K: -k });
                break;
        }
        for (const { A, K } of upperForms) {
            if (A > 0n) {
                const bound = (0, bigint_math_1.floorDiv)(-K, A);
                if (bound < hi) {
                    hi = bound;
                    hiSource = constraintLabel(c);
                }
            }
            else {
                const bound = (0, bigint_math_1.ceilDiv)(-K, A);
                if (bound > lo) {
                    lo = bound;
                    loSource = constraintLabel(c);
                }
            }
        }
        if (lo > hi) {
            return unsat(name, domain, bounds(), {
                type: "empty-interval",
                lower: { value: lo, source: loSource },
                upper: { value: hi, source: hiSource },
            });
        }
    }
    // Combine congruences via CRT.
    let combined = { residue: 0n, modulus: 1n };
    const combinedSources = [];
    for (const { cong, source } of congruences) {
        const merged = (0, bigint_math_1.crtMerge)(combined, cong);
        if ("conflict" in merged) {
            return unsat(name, domain, bounds(), {
                type: "crt-conflict",
                accumulated: [...combinedSources],
                conflicting: source,
                gcd: merged.conflict.gcd,
            });
        }
        combined = merged.congruence;
        combinedSources.push(source);
    }
    const R = combined.residue;
    const M = combined.modulus;
    const first = R + M * (0, bigint_math_1.ceilDiv)(lo - R, M);
    const last = R + M * (0, bigint_math_1.floorDiv)(hi - R, M);
    if (first > last) {
        return unsat(name, domain, bounds(), {
            type: "no-solution-in-interval",
            residue: R,
            modulus: M,
            lo,
            hi,
        });
    }
    // Excluded points that actually remove a solution.
    const cuts = excluded
        .filter((v) => v >= first && v <= last && (0, bigint_math_1.mod)(v - R, M) === 0n)
        .sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
    const uniqueCuts = [];
    for (const v of cuts) {
        if (uniqueCuts.length === 0 || uniqueCuts[uniqueCuts.length - 1] !== v)
            uniqueCuts.push(v);
    }
    // Split the progression at excluded points: maximal runs, hence minimal
    // step-interval representation.
    const intervals = [];
    let segStart = first;
    for (const v of uniqueCuts) {
        const prev = v - M;
        if (prev >= segStart)
            intervals.push({ start: segStart, end: prev, step: M });
        segStart = v + M;
    }
    if (segStart <= last)
        intervals.push({ start: segStart, end: last, step: M });
    let count = 0n;
    for (const iv of intervals)
        count += (iv.end - iv.start) / iv.step + 1n;
    return {
        variable: name,
        domain,
        bounds: bounds(),
        status: "sat",
        intervals,
        solutionCount: count,
        certificate: null,
    };
}
function constantHolds(c) {
    const k = c.expr.constant;
    if (c.kind === "cong")
        return (0, bigint_math_1.mod)(k, c.modulus) === 0n;
    return compareConst(k, c.op);
}
function solveProblem(problem) {
    const perVar = new Map();
    for (const name of problem.domains.keys())
        perVar.set(name, []);
    for (const c of problem.constraints) {
        const vars = [...c.expr.coeffs.keys()];
        if (vars.length > 1) {
            throw new SolveError(`cross-variable constraint is not supported: "${c.source}" (line ${c.line})`);
        }
        if (vars.length === 0) {
            if (!constantHolds(c)) {
                return {
                    status: "unsat",
                    variables: [],
                    certificate: {
                        type: "constant-contradiction",
                        constraint: constraintLabel(c),
                        detail: "constant constraint is false",
                    },
                };
            }
            continue;
        }
        perVar.get(vars[0]).push(c);
    }
    const variables = [];
    let status = "sat";
    for (const [name, domain] of problem.domains) {
        const sol = solveVariable(name, domain, perVar.get(name));
        if (sol.status === "unsat")
            status = "unsat";
        variables.push(sol);
    }
    return { status, variables, certificate: null };
}
