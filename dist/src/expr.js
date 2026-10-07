"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.letIn = exports.v = exports.div = exports.mul = exports.sub = exports.add = exports.bin = exports.lit = void 0;
const lit = (value) => ({ kind: "lit", value });
exports.lit = lit;
const bin = (op, left, right) => ({
    kind: "bin",
    op,
    left,
    right,
});
exports.bin = bin;
const add = (left, right) => (0, exports.bin)("add", left, right);
exports.add = add;
const sub = (left, right) => (0, exports.bin)("sub", left, right);
exports.sub = sub;
const mul = (left, right) => (0, exports.bin)("mul", left, right);
exports.mul = mul;
const div = (left, right) => (0, exports.bin)("div", left, right);
exports.div = div;
const v = (name) => ({ kind: "var", name });
exports.v = v;
const letIn = (name, value, body) => ({
    kind: "let",
    name,
    value,
    body,
});
exports.letIn = letIn;
