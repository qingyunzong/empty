"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.canonicalRule = canonicalRule;
exports.summarize = summarize;
exports.sameSummary = sameSummary;
exports.byId = byId;
const node_crypto_1 = require("node:crypto");
function canonicalRule(rule) {
    return JSON.stringify([rule.id, rule.decision, rule.source, rule.pattern]);
}
function summarize(rules) {
    const ids = [...rules.keys()].sort();
    const decisions = {};
    const sources = {};
    const hash = (0, node_crypto_1.createHash)('sha256');
    for (const id of ids) {
        const rule = rules.get(id);
        if (rule === undefined)
            continue;
        decisions[rule.decision] = (decisions[rule.decision] ?? 0) + 1;
        sources[rule.source] = (sources[rule.source] ?? 0) + 1;
        hash.update(canonicalRule(rule));
        hash.update('\n');
    }
    return {
        ruleCount: ids.length,
        decisions: Object.freeze(decisions),
        sources: Object.freeze(sources),
        hash: hash.digest('hex'),
    };
}
function sameSummary(a, b) {
    return a.hash === b.hash && a.ruleCount === b.ruleCount;
}
function byId(a, b) {
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
