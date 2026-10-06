"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.destructureAssign = destructureAssign;
const expr_1 = require("./expr");
/**
 * Destructuring assignment with two-phase semantics:
 *
 *   Phase 1: evaluate the RHS exactly once, then walk the pattern
 *            left-to-right (depth-first), reading properties/elements
 *            and evaluating default expressions. All results are
 *            collected into a pending binding list.
 *   Phase 2: commit every binding to the scope, in pattern order.
 *
 * If anything in phase 1 throws, no binding is written (atomicity).
 * A default applies only when the matched value is `undefined`
 * (missing); `null` is preserved as-is.
 */
function destructureAssign(scope, pattern, rhs) {
    const root = (0, expr_1.evalExpr)(scope, rhs);
    const pending = [];
    collect(scope, pattern, root, pending);
    for (const [name, value] of pending)
        scope.set(name, value);
}
function collect(scope, pattern, value, out) {
    if (value === undefined && pattern.default !== undefined) {
        value = (0, expr_1.evalExpr)(scope, pattern.default);
    }
    switch (pattern.kind) {
        case 'ident':
            out.push([pattern.name, value]);
            return;
        case 'array': {
            const items = toArray(value);
            pattern.elements.forEach((element, index) => {
                if (element !== null)
                    collect(scope, element, items[index], out);
            });
            if (pattern.rest)
                out.push([pattern.rest.name, items.slice(pattern.elements.length)]);
            return;
        }
        case 'object': {
            const source = toObject(value);
            const used = new Set();
            for (const { key, value: sub } of pattern.props) {
                used.add(key);
                collect(scope, sub, source[key], out);
            }
            if (pattern.rest) {
                const restObj = {};
                for (const key of Object.keys(source)) {
                    if (!used.has(key))
                        restObj[key] = source[key];
                }
                out.push([pattern.rest.name, restObj]);
            }
            return;
        }
    }
}
function toObject(value) {
    if (value === null || value === undefined) {
        throw new TypeError('cannot destructure null or undefined');
    }
    return value;
}
function toArray(value) {
    toObject(value);
    if (!Array.isArray(value))
        throw new TypeError('array pattern requires an array value');
    return value;
}
