"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.invertDiff = invertDiff;
exports.composeDiffs = composeDiffs;
const rules_1 = require("./rules");
function invertDiff(diff) {
    return {
        before: diff.after,
        after: diff.before,
        added: diff.removed,
        removed: diff.added,
    };
}
function composeDiffs(first, second) {
    if (first.after.hash !== second.before.hash) {
        throw new Error('diffs are not adjacent: first.after does not match second.before');
    }
    const removedInSecond = new Set(second.removed.map((rule) => rule.id));
    const addedInSecond = new Set(second.added.map((rule) => rule.id));
    const added = [
        ...first.added.filter((rule) => !removedInSecond.has(rule.id)),
        ...second.added,
    ].sort(rules_1.byId);
    const removed = [
        ...first.removed.filter((rule) => !addedInSecond.has(rule.id)),
        ...second.removed,
    ].sort(rules_1.byId);
    return { before: first.before, after: second.after, added, removed };
}
