import { readFileSync } from "node:fs";
export const DEFAULT_MAX_LENGTH = 12;
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function fail(message) {
    throw new Error(`invalid input: ${message}`);
}
export function parseGraph(raw) {
    if (!isRecord(raw))
        fail("top level must be a JSON object");
    const { certificates, validity, trustedRoots } = raw;
    if (!Array.isArray(certificates))
        fail('"certificates" must be an array');
    const nodes = new Map();
    for (const entry of certificates) {
        if (!isRecord(entry))
            fail("each certificate must be an object");
        const { id, issuers, usages } = entry;
        if (typeof id !== "string" || id.length === 0)
            fail("certificate id must be a non-empty string");
        if (nodes.has(id))
            fail(`duplicate certificate id "${id}"`);
        if (!Array.isArray(issuers) || issuers.some((i) => typeof i !== "string")) {
            fail(`certificate "${id}": issuers must be an array of certificate ids`);
        }
        if (!Array.isArray(usages) || usages.some((u) => typeof u !== "string")) {
            fail(`certificate "${id}": usages must be an array of strings`);
        }
        nodes.set(id, { id, issuers: issuers, usages: usages });
    }
    for (const node of nodes.values()) {
        for (const issuer of node.issuers) {
            if (!nodes.has(issuer)) {
                fail(`certificate "${node.id}": unknown issuer "${issuer}"`);
            }
        }
    }
    if (!isRecord(validity))
        fail('"validity" must be an object mapping id -> boolean');
    const validityMap = new Map();
    for (const [id, value] of Object.entries(validity)) {
        if (typeof value !== "boolean")
            fail(`validity["${id}"] must be a boolean`);
        if (!nodes.has(id))
            fail(`validity references unknown certificate "${id}"`);
        validityMap.set(id, value);
    }
    for (const id of nodes.keys()) {
        if (!validityMap.has(id))
            fail(`missing explicit verification result for certificate "${id}"`);
    }
    if (!Array.isArray(trustedRoots) || trustedRoots.some((r) => typeof r !== "string")) {
        fail('"trustedRoots" must be an array of certificate ids');
    }
    const rootSet = new Set(trustedRoots);
    for (const id of rootSet) {
        if (!nodes.has(id))
            fail(`trusted root "${id}" is not a known certificate`);
    }
    return { nodes, validity: validityMap, trustedRoots: rootSet };
}
export function loadGraphFile(path) {
    let text;
    try {
        text = readFileSync(path, "utf8");
    }
    catch {
        throw new Error(`cannot read input file: ${path}`);
    }
    let raw;
    try {
        raw = JSON.parse(text);
    }
    catch {
        throw new Error(`input file is not valid JSON: ${path}`);
    }
    return parseGraph(raw);
}
