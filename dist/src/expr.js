"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.obj = exports.arr = exports.call = exports.get = exports.ref = exports.lit = void 0;
exports.evalExpr = evalExpr;
const lit = (value) => ({ kind: 'lit', value });
exports.lit = lit;
const ref = (name) => ({ kind: 'ref', name });
exports.ref = ref;
const get = (obj, key) => ({ kind: 'get', obj, key });
exports.get = get;
const call = (fn, ...args) => ({ kind: 'call', fn, args });
exports.call = call;
const arr = (...items) => ({ kind: 'arr', items });
exports.arr = arr;
const obj = (props) => ({
    kind: 'obj',
    props: Object.entries(props).map(([key, value]) => ({ key, value })),
});
exports.obj = obj;
function evalExpr(scope, expr) {
    switch (expr.kind) {
        case 'lit':
            return expr.value;
        case 'ref':
            return scope.get(expr.name);
        case 'get': {
            const target = evalExpr(scope, expr.obj);
            const key = evalExpr(scope, expr.key);
            if (target === null || target === undefined) {
                throw new TypeError(`cannot read property ${String(key)} of ${target}`);
            }
            return target[key];
        }
        case 'call': {
            const fn = evalExpr(scope, expr.fn);
            if (typeof fn !== 'function')
                throw new TypeError('expression is not callable');
            const args = expr.args.map((arg) => evalExpr(scope, arg));
            return fn(...args);
        }
        case 'arr':
            return expr.items.map((item) => evalExpr(scope, item));
        case 'obj': {
            const out = {};
            for (const prop of expr.props)
                out[prop.key] = evalExpr(scope, prop.value);
            return out;
        }
    }
}
