/** Shared pipeline pieces: table normalization, validation, projection, sorting. */
import { makeAccumulator } from "./agg.js";
import { exprColumns, makeResolver } from "./expr.js";
import { QueryError, } from "./types.js";
import { groupKey, toJsonValue, toValue, totalCompare } from "./values.js";
/** Normalize JSON table inputs into rows keyed by qualified column names. */
export function prepare(query, tables) {
    const sources = [];
    const aliases = new Map();
    const all = [query.from, ...(query.joins ?? [])];
    for (const src of all) {
        const alias = src.as ?? src.table;
        if (aliases.has(alias))
            throw new QueryError(`duplicate alias: ${alias}`);
        const table = tables[src.table];
        if (!table)
            throw new QueryError(`unknown table: ${src.table}`);
        const colNames = [...(table.columns ?? [])];
        for (const r of table.rows) {
            for (const k of Object.keys(r)) {
                if (!colNames.includes(k))
                    colNames.push(k);
            }
        }
        const qualified = colNames.map((c) => `${alias}.${c}`);
        aliases.set(alias, qualified);
        const rows = table.rows.map((r) => {
            const row = new Map();
            for (const c of colNames) {
                row.set(`${alias}.${c}`, toValue(r[c] ?? null));
            }
            return row;
        });
        sources.push({ alias, columns: qualified, rows });
    }
    const resolve = makeResolver(aliases);
    const prepared = {
        sources,
        joins: (query.joins ?? []).map((j) => ({ on: j.on })),
        resolve,
    };
    validate(query, prepared);
    return prepared;
}
function validate(query, p) {
    const hasAgg = query.select.some((s) => "agg" in s);
    const groupBy = query.groupBy ?? [];
    const resolvedGroup = groupBy.map((g) => p.resolve(g));
    for (const item of query.select) {
        if ("agg" in item) {
            if (item.agg.arg !== "*")
                p.resolve(item.agg.arg);
            if (item.agg.arg === "*" && item.agg.fn !== "count") {
                throw new QueryError(`${item.agg.fn}(*) is not supported`);
            }
        }
        else {
            const key = p.resolve(item.col);
            if ((hasAgg || groupBy.length > 0) && !resolvedGroup.includes(key)) {
                throw new QueryError(`column ${item.col} must appear in groupBy when aggregating`);
            }
        }
    }
    if (groupBy.length > 0 && !hasAgg) {
        // GROUP BY without aggregates is allowed (acts like DISTINCT on keys).
    }
    for (const j of query.joins ?? [])
        exprColumns(j.on).forEach((c) => p.resolve(c));
    if (query.where)
        exprColumns(query.where).forEach((c) => p.resolve(c));
}
/** Split a predicate into top-level AND conjuncts. */
export function splitConjuncts(e) {
    if ("op" in e && e.op === "and")
        return e.args.flatMap(splitConjuncts);
    return [e];
}
/** Aliases referenced by an expression. */
export function exprAliases(e, resolve) {
    const out = new Set();
    for (const c of exprColumns(e)) {
        const key = resolve(c);
        out.add(key.slice(0, key.indexOf(".")));
    }
    return out;
}
export function planSelect(query, resolve) {
    const groupKeys = (query.groupBy ?? []).map((g) => resolve(g));
    const outputs = query.select.map((item) => {
        if ("agg" in item) {
            const arg = item.agg.arg === "*" ? "*" : resolve(item.agg.arg);
            const name = item.as ?? `${item.agg.fn}(${item.agg.arg})`;
            return { name, kind: "agg", agg: { fn: item.agg.fn, arg } };
        }
        const colKey = resolve(item.col);
        const name = item.as ?? item.col.slice(item.col.indexOf(".") + 1);
        return { name, kind: "col", colKey };
    });
    const aggregate = outputs.some((o) => o.kind === "agg") || groupKeys.length > 0;
    return { groupKeys, outputs, aggregate };
}
export function groupKeyOf(row, keys) {
    return keys.map((k) => groupKey(row.get(k) ?? null)).join("");
}
/** Build one output object from a representative row + accumulator results. */
export function buildOutput(plan, rep, accs) {
    const names = [];
    const values = [];
    let ai = 0;
    for (const o of plan.outputs) {
        names.push(o.name);
        if (o.kind === "col")
            values.push(rep.get(o.colKey) ?? null);
        else
            values.push(accs[ai++].result());
    }
    return { names, values };
}
export function makeAccumulators(plan) {
    return plan.outputs.filter((o) => o.kind === "agg").map((o) => makeAccumulator(o.agg));
}
export function feedAccumulators(plan, accs, row) {
    let ai = 0;
    for (const o of plan.outputs) {
        if (o.kind !== "agg")
            continue;
        const acc = accs[ai++];
        acc.add(o.agg.arg === "*" ? null : (row.get(o.agg.arg) ?? null));
    }
}
/** Deterministic final ordering: sort by output values, left to right. */
export function sortOutput(rows) {
    rows.sort((a, b) => {
        for (let i = 0; i < a.values.length; i++) {
            const c = totalCompare(a.values[i], b.values[i]);
            if (c !== 0)
                return c;
        }
        return 0;
    });
}
export function toJsonRows(rows) {
    return rows.map((r) => {
        const obj = {};
        for (let i = 0; i < r.names.length; i++)
            obj[r.names[i]] = toJsonValue(r.values[i]);
        return obj;
    });
}
