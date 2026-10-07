"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.evaluateNaive = evaluateNaive;
const evaluator_1 = require("./evaluator");
/**
 * Non-shared call-by-name interpreter used to cross-check the shared lazy
 * evaluator. Every variable reference re-evaluates the bound expression;
 * nothing is cached. Self-dependencies are still reported as black holes
 * instead of diverging.
 */
function evaluateNaive(root, stats = { steps: 0 }) {
    const active = new Set();
    function evalNode(node, env) {
        stats.steps += 1;
        switch (node.kind) {
            case "lit":
                return node.value;
            case "bin": {
                const left = evalNode(node.left, env);
                const right = evalNode(node.right, env);
                switch (node.op) {
                    case "add":
                        return left + right;
                    case "sub":
                        return left - right;
                    case "mul":
                        return left * right;
                    case "div":
                        if (right === 0) {
                            throw new evaluator_1.EvalDiagnostic("DIV_BY_ZERO", "division by zero");
                        }
                        return Math.trunc(left / right);
                }
                break;
            }
            case "var": {
                const closure = lookupNaive(env, node.name);
                if (closure === undefined) {
                    throw new evaluator_1.EvalDiagnostic("UNBOUND_VAR", `unbound variable '${node.name}'`);
                }
                if (active.has(closure)) {
                    throw new evaluator_1.EvalDiagnostic("BLACK_HOLE", `black hole: self-dependent binding '${node.name}'`);
                }
                active.add(closure);
                try {
                    return evalNode(closure.expr, closure.env);
                }
                finally {
                    active.delete(closure);
                }
            }
            case "let": {
                const child = { bindings: new Map(), parent: env };
                child.bindings.set(node.name, { expr: node.value, env: child });
                return evalNode(node.body, child);
            }
        }
    }
    return evalNode(root, null);
}
function lookupNaive(env, name) {
    let current = env;
    while (current !== null) {
        const closure = current.bindings.get(name);
        if (closure !== undefined) {
            return closure;
        }
        current = current.parent;
    }
    return undefined;
}
