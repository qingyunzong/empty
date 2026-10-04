"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_MAX_NODES = void 0;
exports.normalizeSpec = normalizeSpec;
exports.DEFAULT_MAX_NODES = 12;
function fail(message) {
    throw new Error(`invalid graph spec: ${message}`);
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function asNodeId(value, field) {
    if (typeof value !== "string" || value.length === 0) {
        fail(`${field} must be a non-empty string`);
    }
    return value;
}
function normalizeSpec(raw) {
    if (!isRecord(raw))
        fail("top-level value must be an object");
    const start = asNodeId(raw.start, "start");
    const end = asNodeId(raw.end, "end");
    let checkpoints = [];
    if (raw.checkpoints !== undefined) {
        if (!Array.isArray(raw.checkpoints))
            fail("checkpoints must be an array");
        checkpoints = raw.checkpoints.map((c, i) => asNodeId(c, `checkpoints[${i}]`));
    }
    let maxNodes = exports.DEFAULT_MAX_NODES;
    if (raw.maxNodes !== undefined) {
        if (typeof raw.maxNodes !== "number" || !Number.isInteger(raw.maxNodes) || raw.maxNodes < 1) {
            fail("maxNodes must be an integer >= 1");
        }
        maxNodes = raw.maxNodes;
    }
    let directed = false;
    if (raw.directed !== undefined) {
        if (typeof raw.directed !== "boolean")
            fail("directed must be a boolean");
        directed = raw.directed;
    }
    if (!Array.isArray(raw.edges))
        fail("edges must be an array");
    const edges = raw.edges.map((e, i) => {
        if (!isRecord(e))
            fail(`edges[${i}] must be an object`);
        const from = asNodeId(e.from, `edges[${i}].from`);
        const to = asNodeId(e.to, `edges[${i}].to`);
        if (typeof e.cost !== "number" || !Number.isFinite(e.cost)) {
            fail(`edges[${i}].cost must be a finite number`);
        }
        return { from, to, cost: e.cost };
    });
    return { start, end, checkpoints, maxNodes, directed, edges };
}
