/**
 * Reference interpreter: pure nested-loop joins, no pushdown,
 * linear-scan grouping. Deliberately naive; used to cross-check the engine.
 */
import { buildOutput, feedAccumulators, groupKeyOf, makeAccumulators, planSelect, prepare, sortOutput, splitConjuncts, toJsonRows, } from "./common.js";
import { evalPredicate } from "./expr.js";
export function runQueryReference(query, tables) {
    const p = prepare(query, tables);
    // Nested-loop cartesian product; each join's ON filters as rows combine.
    let rows = p.sources[0].rows;
    for (let i = 0; i < p.joins.length; i++) {
        const right = p.sources[i + 1].rows;
        const conjuncts = splitConjuncts(p.joins[i].on);
        const next = [];
        for (const l of rows) {
            for (const r of right) {
                const merged = new Map(l);
                for (const [k, v] of r)
                    merged.set(k, v);
                if (conjuncts.every((c) => evalPredicate(c, merged, p.resolve) === true)) {
                    next.push(merged);
                }
            }
        }
        rows = next;
    }
    // WHERE keeps only TRUE.
    if (query.where) {
        const conjuncts = splitConjuncts(query.where);
        rows = rows.filter((row) => conjuncts.every((c) => evalPredicate(c, row, p.resolve) === true));
    }
    const plan = planSelect(query, p.resolve);
    let out;
    if (!plan.aggregate) {
        out = rows.map((row) => buildOutput(plan, row, []));
    }
    else {
        // Linear-scan grouping (no hash map).
        const keys = [];
        const reps = [];
        const accs = [];
        if (plan.groupKeys.length === 0) {
            keys.push("");
            reps.push(rows[0] ?? new Map());
            accs.push(makeAccumulators(plan));
        }
        for (const row of rows) {
            const k = groupKeyOf(row, plan.groupKeys);
            let idx = keys.indexOf(k);
            if (idx < 0) {
                idx = keys.length;
                keys.push(k);
                reps.push(row);
                accs.push(makeAccumulators(plan));
            }
            feedAccumulators(plan, accs[idx], row);
        }
        out = keys.map((_, i) => buildOutput(plan, reps[i], accs[i]));
    }
    sortOutput(out);
    return toJsonRows(out);
}
