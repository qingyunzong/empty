"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.pure = pure;
exports.mapTree = mapTree;
function pure(value) {
    return {
        value,
        *shrinks() { },
    };
}
function mapTree(tree, f) {
    return {
        value: f(tree.value),
        *shrinks() {
            for (const child of tree.shrinks()) {
                yield mapTree(child, f);
            }
        },
    };
}
