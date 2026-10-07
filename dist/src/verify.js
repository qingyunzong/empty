import { multisetEqual, multisetDiff } from "./table.js";
import { execute } from "./plan.js";
/** All multisets of rows of size 0..maxRows over domain^arity. */
export function enumerateTables(arity, domain, maxRows) {
    const tuples = [[]];
    for (let i = 0; i < arity; i++) {
        const prev = tuples.splice(0);
        for (const t of prev)
            for (const d of domain)
                tuples.push([...t, d]);
    }
    const schema = Array.from({ length: arity }, (_, i) => `c${i}`);
    const out = [];
    // Multisets of size k = combinations with repetition of tuples.
    const choose = (start, k, acc) => {
        if (k === 0) {
            out.push({
                schema,
                rows: acc.map((vals) => {
                    const r = {};
                    schema.forEach((c, i) => { r[c] = vals[i] ?? null; });
                    return r;
                }),
            });
            return;
        }
        for (let i = start; i < tuples.length; i++) {
            choose(i, k - 1, [...acc, tuples[i]]);
        }
    };
    for (let k = 0; k <= maxRows; k++)
        choose(0, k, []);
    return out;
}
function* product(lists) {
    if (lists.length === 0) {
        yield [];
        return;
    }
    const [head, ...rest] = lists;
    for (const x of head)
        for (const tail of product(rest))
            yield [x, ...tail];
}
/** Verify `original(tables)` ≡ `rewritten(tables)` over the exhaustive small-table space. */
export function verifyEquivalence(specs, original, rewritten, opts = {}) {
    const domain = opts.domain ?? [null, 0, 1];
    const maxRows = opts.maxRows ?? 2;
    const spaces = specs.map((s) => enumerateTables(s.arity, domain, maxRows));
    let checked = 0;
    for (const combo of product(spaces)) {
        const tables = {};
        specs.forEach((s, i) => {
            // Rename columns to the spec's canonical names c0..c{arity-1} prefixed per table
            // so cross-table column names are globally unique (plan assumption).
            const t = combo[i];
            tables[s.name] = {
                schema: t.schema.map((c) => `${s.name}.${c}`),
                rows: t.rows.map((r) => {
                    const nr = {};
                    t.schema.forEach((c, j) => { nr[`${s.name}.${c}`] = r[c] ?? null; });
                    return nr;
                }),
            };
        });
        checked++;
        const a = execute(original(tables));
        const b = execute(rewritten(tables));
        if (!multisetEqual(a, b)) {
            return { ok: false, combinationsChecked: checked, counterexample: { tables, diff: multisetDiff(a, b) } };
        }
    }
    return { ok: true, combinationsChecked: checked };
}
