import { conjuncts, isNullRejecting, referencedColumns, showExpr, and } from "./expr.js";
import { schemaOf, showPlan } from "./plan.js";
const onlyOn = (c, schema) => {
    const cols = referencedColumns(c);
    return cols.size > 0 && [...cols].every((x) => schema.includes(x));
};
function mkCert(rule, preconditions, before, after) {
    return { rule, preconditions, before: showPlan(before), after: showPlan(after) };
}
/**
 * RULE filter-pushdown-into-join:
 *   Filter(p, Join[kind](jp, L, R))  ->  Filter(residual, Join[kind'](jp, L', R'))
 *
 * Public preconditions (all recorded in the certificate):
 *  (P0 join-kind strengthening) If some conjunct references ONLY a
 *     null-supplying side S and is NULL-rejecting w.r.t. schema(S), then no
 *     preserved row can survive the filter (its S-columns are all NULL), so
 *     the join kind is strengthened first: left/right -> inner,
 *     full -> left/right/inner. This is REQUIRED for legality: pushing a
 *     predicate below an outer join without strengthening would resurrect
 *     preserved rows that the original filter discarded.
 *  (P1 column subset) A conjunct is pushed into side S only if every column
 *     it references belongs to schema(S).
 *  (P2 null-rejection) A conjunct is pushed into a NULL-SUPPLYING side only
 *     if it is NULL-rejecting there; otherwise it stays as residual Filter
 *     above the join. Pushing into a preserved side is always legal.
 */
export function filterPushdownIntoJoin(plan) {
    if (plan.op !== "filter" || plan.input.op !== "join")
        return null;
    const j = plan.input;
    const lSchema = schemaOf(j.left);
    const rSchema = schemaOf(j.right);
    const cs = conjuncts(plan.pred);
    const preconditions = [];
    const nullRejectingConjunctOn = (schema) => cs.find((c) => onlyOn(c, schema) && isNullRejecting(c, schema));
    // Phase 1 (P0): strengthen the join kind using null-rejecting conjuncts.
    let kind = j.kind;
    if (j.kind === "left" || j.kind === "right" || j.kind === "full") {
        const onL = nullRejectingConjunctOn(lSchema); // kills rows with NULLs on the left
        const onR = nullRejectingConjunctOn(rSchema); // kills rows with NULLs on the right
        const note = (side, c) => {
            preconditions.push({
                name: "P0-null-rejecting-strengthens-kind",
                detail: `conjunct ${showExpr(c)} references only ${side} columns and is NULL-rejecting there; preserved rows with NULL ${side} columns cannot survive the filter`,
            });
        };
        if (j.kind === "left" && onR) {
            kind = "inner";
            note("right", onR);
        }
        else if (j.kind === "right" && onL) {
            kind = "inner";
            note("left", onL);
        }
        else if (j.kind === "full") {
            if (onL && onR) {
                kind = "inner";
                note("left", onL);
                note("right", onR);
            }
            else if (onR) {
                kind = "right";
                note("right", onR);
            } // only right-side preservation remains
            else if (onL) {
                kind = "left";
                note("left", onL);
            }
        }
    }
    // Phase 2 (P1, P2): push conjuncts according to the (strengthened) kind.
    const leftConj = [];
    const rightConj = [];
    const residual = [];
    for (const c of cs) {
        const cols = referencedColumns(c);
        const inL = onlyOn(c, lSchema);
        const inR = onlyOn(c, rSchema);
        const target = inL && !inR ? "left" : inR && !inL ? "right" : null;
        if (target === null) {
            residual.push(c);
            preconditions.push({
                name: "P1-column-subset",
                detail: `conjunct ${showExpr(c)} references both/neither side ({${[...cols].join(",")}}); kept above join`,
            });
            continue;
        }
        const schema = target === "left" ? lSchema : rSchema;
        const nullSupplying = (target === "left" && (kind === "right" || kind === "full")) ||
            (target === "right" && (kind === "left" || kind === "full"));
        if (nullSupplying && !isNullRejecting(c, schema)) {
            residual.push(c);
            preconditions.push({
                name: "P2-null-rejecting",
                detail: `conjunct ${showExpr(c)} targets null-supplying ${target} side of ${kind} join but is NOT null-rejecting; kept above join`,
            });
            continue;
        }
        (target === "left" ? leftConj : rightConj).push(c);
        preconditions.push({
            name: "P1-column-subset",
            detail: `cols(${showExpr(c)}) = {${[...cols].join(",")}} ⊆ ${target} schema {${schema.join(",")}}`,
        });
        if (nullSupplying) {
            preconditions.push({
                name: "P2-null-rejecting",
                detail: `${showExpr(c)} is NULL-rejecting w.r.t. ${target} schema (evaluates non-TRUE on the all-NULL row)`,
            });
        }
    }
    const kindChanged = kind !== j.kind;
    if (leftConj.length === 0 && rightConj.length === 0 && !kindChanged)
        return null;
    const newLeft = leftConj.length > 0 ? { op: "filter", pred: and(...leftConj), input: j.left } : j.left;
    const newRight = rightConj.length > 0 ? { op: "filter", pred: and(...rightConj), input: j.right } : j.right;
    let out = { ...j, kind, left: newLeft, right: newRight };
    if (residual.length > 0)
        out = { op: "filter", pred: and(...residual), input: out };
    return { plan: out, certificate: mkCert("filter-pushdown-into-join", preconditions, plan, out) };
}
/**
 * RULE outer-to-inner-join:
 *   Filter(p, Join[outer](jp, L, R)) -> Filter(p, Join[inner](jp, L, R))
 *
 * Public precondition: p has a conjunct referencing only a NULL-supplying
 * side that is NULL-rejecting there — preserved rows cannot survive the
 * filter, so the outer join degenerates. For FULL joins both sides must
 * carry such a conjunct.
 */
export function outerToInnerJoin(plan) {
    if (plan.op !== "filter" || plan.input.op !== "join")
        return null;
    const j = plan.input;
    if (j.kind !== "left" && j.kind !== "right" && j.kind !== "full")
        return null;
    const cs = conjuncts(plan.pred);
    const lSchema = schemaOf(j.left);
    const rSchema = schemaOf(j.right);
    const rejectingOn = (schema) => cs.find((c) => onlyOn(c, schema) && isNullRejecting(c, schema));
    const preconditions = [];
    let newKind = null;
    if (j.kind === "left") {
        const hit = rejectingOn(rSchema);
        if (hit) {
            newKind = "inner";
            preconditions.push({
                name: "null-rejecting-on-null-supplying-side",
                detail: `conjunct ${showExpr(hit)} references only right (null-supplying) columns and is NULL-rejecting there`,
            });
        }
    }
    else if (j.kind === "right") {
        const hit = rejectingOn(lSchema);
        if (hit) {
            newKind = "inner";
            preconditions.push({
                name: "null-rejecting-on-null-supplying-side",
                detail: `conjunct ${showExpr(hit)} references only left (null-supplying) columns and is NULL-rejecting there`,
            });
        }
    }
    else {
        const hl = rejectingOn(lSchema);
        const hr = rejectingOn(rSchema);
        if (hl && hr) {
            newKind = "inner";
            preconditions.push({ name: "null-rejecting-on-null-supplying-side", detail: `conjunct ${showExpr(hl)} is NULL-rejecting on the left (null-supplying) side` }, { name: "null-rejecting-on-null-supplying-side", detail: `conjunct ${showExpr(hr)} is NULL-rejecting on the right (null-supplying) side` });
        }
    }
    if (newKind === null)
        return null;
    const out = { op: "filter", pred: plan.pred, input: { ...j, kind: newKind } };
    return { plan: out, certificate: mkCert("outer-to-inner-join", preconditions, plan, out) };
}
/**
 * RULE project-elimination (identity):
 *   Project(cols, input) -> input
 * Public precondition: cols is exactly schema(input), same order — the
 * projection is a no-op on both values AND duplicates.
 */
export function projectEliminationIdentity(plan) {
    if (plan.op !== "project")
        return null;
    const inner = schemaOf(plan.input);
    const same = plan.cols.length === inner.length && plan.cols.every((c, i) => c === inner[i]);
    if (!same)
        return null;
    const preconditions = [{
            name: "identity-projection",
            detail: `project list (${plan.cols.join(",")}) equals input schema (${inner.join(",")}) in order`,
        }];
    return { plan: plan.input, certificate: mkCert("project-elimination-identity", preconditions, plan, plan.input) };
}
/**
 * RULE project-elimination (nested merge):
 *   Project(a, Project(b, input)) -> Project(a, input)
 * Public precondition: every column of a appears in b (the inner projection
 * did not drop anything the outer one needs).
 */
export function projectEliminationNested(plan) {
    if (plan.op !== "project" || plan.input.op !== "project")
        return null;
    const innerCols = plan.input.cols;
    if (!plan.cols.every((c) => innerCols.includes(c)))
        return null;
    const preconditions = [{
            name: "outer-subset-of-inner",
            detail: `outer project (${plan.cols.join(",")}) ⊆ inner project (${innerCols.join(",")})`,
        }];
    const out = { op: "project", cols: plan.cols, input: plan.input.input };
    return { plan: out, certificate: mkCert("project-elimination-nested", preconditions, plan, out) };
}
/**
 * RULE join-commutativity (inner only):
 *   Join[inner](p, L, R) -> Project(schema(L)+schema(R), Join[inner](p, R, L))
 * Public precondition: join kind is INNER (outer joins are not commutative;
 * the rule refuses otherwise). The re-projection preserves output column order.
 */
export function joinCommutativity(plan) {
    if (plan.op !== "join" || plan.kind !== "inner")
        return null;
    const preconditions = [{
            name: "join-kind-is-inner",
            detail: "commutativity holds for inner joins under bag semantics; outer joins excluded",
        }];
    const swapped = { ...plan, left: plan.right, right: plan.left };
    const out = { op: "project", cols: schemaOf(plan), input: swapped };
    return { plan: out, certificate: mkCert("join-commutativity-inner", preconditions, plan, out) };
}
/**
 * RULE left-to-right-join:
 *   Join[left](p, L, R) -> Project(schema(L)+schema(R), Join[right](p, R, L))
 * Public precondition: join kind is LEFT (symmetric rule maps RIGHT to LEFT).
 * Legal unconditionally; re-projection preserves output column order.
 */
export function leftRightJoinSwap(plan) {
    if (plan.op !== "join" || (plan.kind !== "left" && plan.kind !== "right"))
        return null;
    const newKind = plan.kind === "left" ? "right" : "left";
    const preconditions = [{
            name: "outer-join-mirror",
            detail: `${plan.kind} join mirrored to ${newKind} join with operands swapped; re-projection restores column order`,
        }];
    const swapped = { ...plan, kind: newKind, left: plan.right, right: plan.left };
    const out = { op: "project", cols: schemaOf(plan), input: swapped };
    return { plan: out, certificate: mkCert("left-right-join-swap", preconditions, plan, out) };
}
/** All rules, in optimizer application order. */
export const allRules = [
    filterPushdownIntoJoin,
    outerToInnerJoin,
    projectEliminationIdentity,
    projectEliminationNested,
    joinCommutativity,
    leftRightJoinSwap,
];
