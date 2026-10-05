/**
 * Config loader over a virtual file table.
 *
 * Features:
 *  - `$include`: relative includes resolved against the including file.
 *  - Deep merge: objects merge, scalars/arrays override, `key+` appends arrays.
 *    The append intent propagates across include boundaries: a `key+` array
 *    appends to everything assembled before it in the final merge order.
 *  - Cycle detection on the current include stack only (diamonds are fine).
 *  - Every final field records its source chain (files in application order).
 *  - Errors carry the full include path from the entry file.
 */
export class ConfigError extends Error {
    includeChain;
    constructor(message, includeChain) {
        super(`${message} (include path: ${includeChain.join(" -> ")})`);
        this.name = "ConfigError";
        this.includeChain = [...includeChain];
    }
}
const INCLUDE_KEY = "$include";
const APPEND_SUFFIX = "+";
export function loadConfig(files, entry) {
    const table = new Map();
    const rawEntries = files instanceof Map ? files.entries() : Object.entries(files);
    for (const [name, content] of rawEntries) {
        table.set(normalizePath(name), content);
    }
    const entryPath = normalizePath(entry);
    const root = loadFile(table, entryPath, []);
    const provenance = {};
    const config = unwrap(root, "", provenance);
    return { config: config, provenance };
}
function loadFile(table, filePath, stack) {
    const chain = [...stack, filePath];
    if (stack.includes(filePath)) {
        throw new ConfigError(`circular include: ${chain.join(" -> ")}`, chain);
    }
    const raw = table.get(filePath);
    if (raw === undefined) {
        throw new ConfigError(`file not found: ${filePath}`, chain);
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch (err) {
        throw new ConfigError(`invalid JSON in ${filePath}: ${err.message}`, chain);
    }
    if (!isPlainObject(parsed)) {
        throw new ConfigError(`top-level config must be a JSON object in ${filePath}`, chain);
    }
    let merged = { chain: [filePath], value: {} };
    const includes = parsed[INCLUDE_KEY];
    if (includes !== undefined) {
        const specs = Array.isArray(includes) ? includes : [includes];
        for (const spec of specs) {
            if (typeof spec !== "string") {
                throw new ConfigError(`$include entries must be strings in ${filePath}`, chain);
            }
            const childPath = resolvePath(filePath, spec);
            const child = loadFile(table, childPath, chain);
            merged = mergeNodes(merged, child, "", chain);
        }
    }
    const body = {};
    for (const [key, value] of Object.entries(parsed)) {
        if (key !== INCLUDE_KEY)
            body[key] = value;
    }
    merged = mergeNodes(merged, tag(body, filePath, "", chain), "", chain);
    return merged;
}
/** Deep-merge overlay onto base, accumulating source chains. */
function mergeNodes(base, overlay, path, errChain) {
    const chain = concatChain(base.chain, overlay.chain);
    if (isPlainObject(base.value) && isPlainObject(overlay.value)) {
        const out = { ...base.value };
        for (const [key, overlayChild] of Object.entries(overlay.value)) {
            const childPath = path === "" ? key : `${path}.${key}`;
            const baseChild = out[key];
            if (overlayChild.append === true) {
                out[key] = appendArrays(baseChild, overlayChild, childPath, errChain);
            }
            else if (baseChild !== undefined) {
                out[key] = mergeNodes(baseChild, overlayChild, childPath, errChain);
            }
            else {
                out[key] = overlayChild;
            }
        }
        return { chain, value: out };
    }
    // Overlay wins for scalars, arrays, and type changes; chains accumulate.
    return { chain, value: overlay.value };
}
function appendArrays(baseChild, overlayChild, path, errChain) {
    if (!Array.isArray(overlayChild.value)) {
        throw new ConfigError(`cannot append non-array value to field "${path}"`, errChain);
    }
    if (baseChild === undefined) {
        return { chain: overlayChild.chain, value: [...overlayChild.value], append: overlayChild.append };
    }
    if (!Array.isArray(baseChild.value)) {
        throw new ConfigError(`cannot append to non-array field "${path}"`, errChain);
    }
    return {
        chain: concatChain(baseChild.chain, overlayChild.chain),
        value: [...baseChild.value, ...overlayChild.value],
        append: overlayChild.append,
    };
}
/** Recursively tag every node of a parsed JSON value with its source file. */
function tag(value, file, path, errChain) {
    if (Array.isArray(value)) {
        return { chain: [file], value: value.map((item) => tag(item, file, path, errChain)) };
    }
    if (isPlainObject(value)) {
        const out = {};
        for (const [rawKey, child] of Object.entries(value)) {
            const append = rawKey.endsWith(APPEND_SUFFIX) && rawKey.length > 1;
            const key = append ? rawKey.slice(0, -1) : rawKey;
            const childPath = path === "" ? key : `${path}.${key}`;
            const tagged = tag(child, file, childPath, errChain);
            if (append) {
                const existing = out[key];
                out[key] = {
                    ...(existing !== undefined
                        ? appendArrays(existing, { ...tagged, append: true }, childPath, errChain)
                        : { chain: tagged.chain, value: tagged.value }),
                    append: true,
                };
            }
            else {
                out[key] = tagged;
            }
        }
        return { chain: [file], value: out };
    }
    return { chain: [file], value };
}
/** Strip tags into a plain config value while recording provenance per path. */
function unwrap(node, path, provenance) {
    if (path !== "")
        provenance[path] = node.chain;
    if (Array.isArray(node.value)) {
        return node.value.map((item, index) => unwrap(item, path === "" ? String(index) : `${path}.${index}`, provenance));
    }
    if (isPlainObject(node.value)) {
        const out = {};
        for (const [key, child] of Object.entries(node.value)) {
            out[key] = unwrap(child, path === "" ? key : `${path}.${key}`, provenance);
        }
        return out;
    }
    return node.value;
}
/** Ordered union: every contributing file appears once, in application order. */
function concatChain(first, second) {
    const out = [...first];
    for (const file of second) {
        if (!out.includes(file))
            out.push(file);
    }
    return out;
}
function isPlainObject(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
// --- virtual path utilities (POSIX-style) ---
export function normalizePath(path) {
    const absolute = path.startsWith("/");
    const parts = [];
    for (const segment of path.split("/")) {
        if (segment === "" || segment === ".")
            continue;
        if (segment === "..") {
            const last = parts[parts.length - 1];
            if (last !== undefined && last !== "..")
                parts.pop();
            else if (!absolute)
                parts.push("..");
        }
        else {
            parts.push(segment);
        }
    }
    const joined = parts.join("/");
    if (absolute)
        return `/${joined}`;
    return joined === "" ? "." : joined;
}
function dirname(path) {
    const index = path.lastIndexOf("/");
    if (index < 0)
        return ".";
    if (index === 0)
        return "/";
    return path.slice(0, index);
}
export function resolvePath(fromFile, spec) {
    if (spec.startsWith("/"))
        return normalizePath(spec);
    return normalizePath(`${dirname(fromFile)}/${spec}`);
}
