"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.withDefault = exports.objPat = exports.arrPat = exports.id = void 0;
const id = (name, def) => def === undefined ? { kind: 'ident', name } : { kind: 'ident', name, default: def };
exports.id = id;
const arrPat = (elements, rest) => ({
    kind: 'array',
    elements,
    ...(rest === undefined ? {} : { rest: { name: rest } }),
});
exports.arrPat = arrPat;
const objPat = (props, rest) => ({
    kind: 'object',
    props: Object.entries(props).map(([key, value]) => ({ key, value })),
    ...(rest === undefined ? {} : { rest: { name: rest } }),
});
exports.objPat = objPat;
/** Attach a default to any (possibly nested) pattern, e.g. `[{a} = d()]`. */
const withDefault = (pattern, def) => ({ ...pattern, default: def });
exports.withDefault = withDefault;
